// servertool_hooks tests, split from servertool_hooks.rs to satisfy
// verify:v3-file-size ratchet. Semantics unchanged: this module is the
// direct child of servertool_hooks, so `use super::*` resolves identically
// to the former inline `mod tests`.

use super::*;
use crate::hub_v1::stopless_injection::{
    inject_v3_stopless_provider_contract, tool_is_reasoning_stop,
};
use serde_json::json;

const CMD_ARGS: &str = "{\"cmd\":\"routecodex hook run reasoningStop\"}";

fn response_call(id: &str, args: &str) -> Value {
    json!({"type":"function_call","call_id":id,"name":"exec_command","arguments":args})
}

fn response_output(id: &str) -> Value {
    json!({"type":"function_call_output","call_id":id,"output":"error"})
}

fn chat_call(id: &str, args: &str) -> Value {
    json!({"role":"assistant","tool_calls":[{"id":id,"type":"function","function":{"name":"exec_command","arguments":args}}]})
}

fn chat_output(id: &str) -> Value {
    json!({"role":"tool","tool_call_id":id,"content":"error"})
}

#[test]
fn resp03_stopless_reasoning_stop_projects_to_noop_with_visible_text() {
    let payload = json!({
        "id": "resp_stopless_noop_1",
        "status": "completed",
        "finish_reason": "stop",
        "output": [
            {"type":"reasoning","summary":[{"type":"summary_text","text":"思考内容"}]},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"可见文字"}]},
            {"type":"function_call","call_id":"call_stop_1","name":"exec_command","arguments":"{\"cmd\":\"routecodex hook run reasoningStop\",\"stopreason\":0,\"reason\":\"完成\",\"evidence\":\"证据内容\"}"}
        ],
        "output_text": "可见文字"
    });
    let projected = strip_current_stopless_response_artifacts(
        &payload,
        "call_stop_1",
        Some("完成。\n证据：证据内容"),
        true,
    );
    let output = projected["output"].as_array().expect("output array");
    let noop_calls = output
        .iter()
        .filter(|item| {
            item.get("type").and_then(Value::as_str) == Some("function_call")
                && item.get("name").and_then(Value::as_str) == Some("noop")
                && item.get("arguments").is_none()
        })
        .count();
    assert_eq!(
        noop_calls, 1,
        "reasoningStop must project to a parameterless noop call: {projected}"
    );
    let has_text = output.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("message")
            && item
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|parts| {
                    parts.iter().any(|part| {
                        part.get("type").and_then(Value::as_str) == Some("output_text")
                            && part
                                .get("text")
                                .and_then(Value::as_str)
                                .is_some_and(|text| {
                                    text.contains("可见文字") && text.contains("证据内容")
                                })
                    })
                })
    });
    assert!(
        has_text,
        "visible text and evidence must not be lost: {projected}"
    );
    assert_eq!(projected["finish_reason"], "tool_calls");
    assert_eq!(projected["status"], "requires_action");
}

#[test]
fn dynamic_stopless_cli_pairs_are_exact_json_cmd_only() {
    let call = response_call("call-dynamic", CMD_ARGS);
    assert!(output_pairs_immediately_after_stopless_cli_call(
        &response_output("call-dynamic"),
        Some(&call)
    ));
    let call = chat_call("chat-dynamic", CMD_ARGS);
    assert!(chat_output_pairs_immediately_after_stopless_cli_call(
        &chat_output("chat-dynamic"),
        Some(&call)
    ));
    for arguments in [
        "{\"cmd\":\"echo routecodex hook run reasoningStop\"}",
        "routecodex hook run reasoningStop",
        "{\"cmd\":\"routecodex hook run reasoningStop\",\"workdir\":\"/tmp\"}",
    ] {
        assert_eq!(stopless_cli_call_id(&response_call("bad", arguments)), None);
        assert_eq!(
            stopless_chat_cli_call_id(&chat_call("bad-chat", arguments)),
            None
        );
    }
}

#[test]
fn web_search_request_hook_activates_local_surface_for_declared_tool() {
    let mut payload = json!({
        "model": "local-model",
        "input": [{"type":"message","role":"user","content":"search the web"}],
        "tools": [
            {"type": "web_search", "external_web_access": true, "search_content_types": ["text"]}
        ]
    });
    let state = apply_v3_web_search_request_hook_at_req04(&mut payload)
        .expect("hook must not fail")
        .expect("web_search declaration must activate the websearch instance");
    assert_eq!(
        state.phase(),
        V3WebSearchCenterPhase::LocalToolSurfaceActive
    );
    assert_eq!(
        state.transition_reason(),
        Some("req04_web_search_surface_active")
    );
}

#[test]
fn web_search_request_hook_activates_for_web_search_preview_declaration() {
    let mut payload = json!({
        "model": "local-model",
        "input": "search",
        "tools": [{"type": "web_search_preview", "search_context_size": "medium"}]
    });
    let state = apply_v3_web_search_request_hook_at_req04(&mut payload)
        .expect("hook must not fail")
        .expect("web_search_preview declaration must activate the websearch instance");
    assert_eq!(
        state.phase(),
        V3WebSearchCenterPhase::LocalToolSurfaceActive
    );
}

#[test]
fn web_search_request_hook_stays_idle_without_declaration() {
    let mut payload = json!({
        "model": "local-model",
        "input": "hello",
        "tools": [
            {"type": "function", "name": "read_file", "description": "read", "parameters": {"type":"object","properties":{}}}
        ]
    });
    let state =
        apply_v3_web_search_request_hook_at_req04(&mut payload).expect("hook must not fail");
    assert!(
        state.is_none(),
        "ordinary tools must not activate websearch"
    );
}

#[test]
fn web_search_request_hook_ignores_tools_missing() {
    let mut payload = json!({"model": "local-model", "input": "hello"});
    let state =
        apply_v3_web_search_request_hook_at_req04(&mut payload).expect("hook must not fail");
    assert!(state.is_none());
}

#[test]
fn web_search_request_hook_activates_for_openai_chat_function_declaration() {
    // chat 入口：client 用 OpenAI Chat 形态 function tool 声明 websearch。
    let mut payload = json!({
        "model": "local-model",
        "messages": [{"role":"user","content":"search the web"}],
        "tools": [
            {"type": "function", "function": {"name": "websearch",
             "description": "Search the web", "parameters": {"type":"object","properties":{}}}}
        ]
    });
    let state = apply_v3_web_search_request_hook_at_req04(&mut payload)
        .expect("hook must not fail")
        .expect("chat websearch function declaration must activate the websearch instance");
    assert_eq!(
        state.phase(),
        V3WebSearchCenterPhase::LocalToolSurfaceActive
    );
}

#[test]
fn web_search_request_hook_activates_for_anthropic_server_tool_declaration() {
    // anthropic 入口：client 用 Anthropic server tool 声明 web_search。
    let mut payload = json!({
        "model": "local-model",
        "messages": [{"role":"user","content":"search the web"}],
        "tools": [
            {"name": "web_search", "description": "Search the web"}
        ]
    });
    let state = apply_v3_web_search_request_hook_at_req04(&mut payload)
        .expect("hook must not fail")
        .expect("anthropic web_search declaration must activate the websearch instance");
    assert_eq!(
        state.phase(),
        V3WebSearchCenterPhase::LocalToolSurfaceActive
    );
}

#[test]
fn web_search_request_hook_keeps_idle_for_other_chat_function_names() {
    // 非 websearch 的普通 function 声明不得误激活。
    let mut payload = json!({
        "model": "local-model",
        "messages": [{"role":"user","content":"hi"}],
        "tools": [
            {"type": "function", "function": {"name": "read_file", "parameters": {"type":"object","properties":{}}}}
        ]
    });
    let state =
        apply_v3_web_search_request_hook_at_req04(&mut payload).expect("hook must not fail");
    assert!(state.is_none());
}

#[test]
fn first_local_websearch_tool_call_extracts_and_validates() {
    let payload = json!({
        "output": [
            {"type":"function_call","call_id":"call_ws_1","name":"websearch","arguments":"{\"query\":\"routecodex v3\",\"count\":5}"},
            {"type":"function_call","call_id":"call_ws_2","name":"read_file","arguments":"{}"}
        ]
    });
    let call = first_local_websearch_tool_call(&payload)
        .expect("extract")
        .expect("websearch call present");
    assert_eq!(call.call_id, "call_ws_1");
    assert_eq!(call.query, "routecodex v3");
    assert_eq!(call.count, Some(5));
    assert!(call.recency.is_none());
}

#[test]
fn first_local_websearch_tool_call_rejects_missing_query() {
    let payload = json!({
        "output": [
            {"type":"function_call","call_id":"call_ws_1","name":"websearch","arguments":"{\"count\":5}"}
        ]
    });
    let error = first_local_websearch_tool_call(&payload).expect_err("missing query must fail");
    assert!(error.to_string().contains("requires a non-empty query"));
}

#[test]
fn first_local_websearch_tool_call_ignores_other_tools() {
    let payload = json!({
        "output": [
            {"type":"function_call","call_id":"call_a","name":"exec_command","arguments":"{}"}
        ]
    });
    assert!(first_local_websearch_tool_call(&payload)
        .expect("extract")
        .is_none());
}

#[test]
fn strip_local_websearch_tool_call_removes_only_matching_call() {
    let payload = json!({
        "output": [
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"searching"}]},
            {"type":"function_call","call_id":"call_ws_1","name":"websearch","arguments":"{\"query\":\"x\"}"},
            {"type":"function_call","call_id":"call_ws_2","name":"read_file","arguments":"{}"}
        ]
    });
    let stripped = strip_local_websearch_tool_call(&payload, "call_ws_1");
    let output = stripped["output"].as_array().expect("output array");
    assert_eq!(output.len(), 2);
    assert!(
        output
            .iter()
            .all(|item| item.get("call_id").and_then(Value::as_str) != Some("call_ws_1")),
        "websearch call must be stripped"
    );
    assert!(
        output
            .iter()
            .any(|item| item.get("call_id").and_then(Value::as_str) == Some("call_ws_2")),
        "adjacent ordinary tool must remain"
    );
}

#[test]
fn strip_local_websearch_tool_call_removes_openai_chat_choices_tool_call() {
    let payload = json!({
        "id": "chatcmpl_ws",
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "searching",
                "tool_calls": [
                    {
                        "id": "call_ws_chat",
                        "type": "function",
                        "function": {"name": "websearch", "arguments": "{\"query\":\"x\"}"}
                    },
                    {
                        "id": "call_other",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": "{}"}
                    }
                ]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let stripped = strip_local_websearch_tool_call(&payload, "call_ws_chat");
    let tool_calls = stripped["choices"][0]["message"]["tool_calls"]
        .as_array()
        .expect("tool_calls array");
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0]["id"], "call_other");
}

#[test]
fn strip_local_websearch_tool_call_removes_anthropic_tool_use() {
    let payload = json!({
        "id": "msg_ws",
        "type": "message",
        "role": "assistant",
        "content": [
            {"type": "text", "text": "searching"},
            {
                "type": "tool_use",
                "id": "call_ws_anthropic",
                "name": "web_search",
                "input": {"query": "x"}
            }
        ],
        "stop_reason": "tool_use"
    });
    let stripped = strip_local_websearch_tool_call(&payload, "call_ws_anthropic");
    let content = stripped["content"].as_array().expect("content array");
    assert_eq!(content.len(), 1);
    assert!(content
        .iter()
        .all(|item| item.get("type") != Some(&Value::String("tool_use".into()))));
}

#[test]
fn active_stopless_does_not_treat_message_text_as_injected_guidance() {
    let mut payload = json!({
        "model": "local-model",
        "messages": [{
            "role": "user",
            "content": "请解释历史中提到的当前轮推进准则，不要执行任何工具"
        }]
    });

    inject_v3_stopless_provider_contract(&mut payload, 0).expect("stopless injection must succeed");

    let tools = payload["tools"].as_array().expect("tools must be injected");
    assert!(tools
        .iter()
        .any(|tool| { tool.get("name").and_then(Value::as_str) == Some("reasoningStop") }));
    assert_eq!(payload["tool_choice"], "required");
}

#[test]
fn active_stopless_thinking_replaces_none_tool_choice_when_injecting_control_tool() {
    let mut payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "continue"}],
        "reasoning_effort": "high",
        "tool_choice": "none"
    });

    inject_v3_stopless_provider_contract(&mut payload, 0)
        .expect("thinking-mode stopless injection must succeed");

    assert_eq!(payload["tool_choice"], "auto");
    assert!(payload["tools"]
        .as_array()
        .is_some_and(|tools| { tools.iter().any(|tool| tool_is_reasoning_stop(tool)) }));
}

#[test]
fn active_stopless_preserves_nested_reasoning_stop_tool_without_duplicate() {
    let mut payload = json!({
        "model": "local-model",
        "messages": [{"role": "user", "content": "continue"}],
        "tools": [{
            "type": "function",
            "function": {"name": "reasoningStop", "parameters": {"type": "object"}}
        }]
    });

    inject_v3_stopless_provider_contract(&mut payload, 0).expect("stopless injection must succeed");

    let tools = payload["tools"].as_array().expect("tools array");
    assert_eq!(
        tools
            .iter()
            .filter(|tool| tool_is_reasoning_stop(tool))
            .count(),
        1
    );
    assert_eq!(payload["tool_choice"], "required");
}

#[test]
fn active_stopless_ignores_historical_guidance_for_current_turn_contract() {
    let mut payload = json!({
        "model": "local-model",
        "messages": [
            {"role": "system", "content": crate::hub_v1::stopless_injection::stopless_provider_guidance()},
            {"role": "user", "content": "continue"}
        ]
    });

    inject_v3_stopless_provider_contract(&mut payload, 1).expect("stopless injection must succeed");

    let messages = payload["messages"].as_array().expect("messages array");
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(messages[1]["role"], "system");
    assert!(messages[1]["content"]
        .as_str()
        .unwrap()
        .contains("当前轮推进准则"));
    assert_eq!(payload["tool_choice"], "required");
}
