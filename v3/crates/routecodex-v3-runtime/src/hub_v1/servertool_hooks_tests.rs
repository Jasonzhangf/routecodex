// servertool_hooks tests, split from servertool_hooks.rs to satisfy
// verify:v3-file-size ratchet. Semantics unchanged: this module is the
// direct child of servertool_hooks, so `use super::*` resolves identically
// to the former inline `mod tests`.

use super::*;
use crate::hub_v1::anthropic_codec::encode_v3_responses_semantic_as_anthropic_request;
use crate::hub_v1::stopless_injection::{
    inject_v3_stopless_provider_contract, tool_is_reasoning_stop,
};
use serde_json::json;

#[test]
fn req04_tool_thinking_injects_detailed_guidance_into_tool_list() {
    let mut payload = json!({
        "tools": [
            {"type":"function","name":"exec","description":"run command","parameters":{"type":"object"}},
            {"type":"reasoningStop","name":"reasoningStop","description":"internal"}
        ],
        "instructions":"client instructions"
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject");
    let guidance = payload["tools"][0]["description"].as_str().unwrap();
    assert!(guidance.contains("工具调用协议（只适用于本轮工具调用"));
    assert!(guidance.contains("工具参数 JSON 对象本层"));
    assert!(guidance.contains("Anthropic 的 `input`、Responses/Chat 的 `arguments`"));
    assert!(guidance.contains("goal_alignment_confidence"));
    assert!(guidance.contains("model_id"));
    assert!(guidance.contains("可选字段不要用占位值"));
    assert_eq!(payload["tools"][1]["description"], "internal");
}

#[test]
fn responses_tool_output_continuation_is_not_a_new_tool_thinking_user_turn() {
    let payload = json!({
        "previous_response_id": "resp_previous",
        "input": [{
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "done"
        }]
    });

    assert!(is_v3_tool_thinking_output_continuation(
        &payload,
        payload["previous_response_id"].as_str()
    ));
}

#[test]
fn fresh_responses_user_input_is_not_a_tool_output_continuation() {
    let payload = json!({
        "previous_response_id": "resp_previous",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "continue"}]
        }]
    });

    assert!(!is_v3_tool_thinking_output_continuation(
        &payload,
        payload["previous_response_id"].as_str()
    ));
}

#[test]
fn req04_tool_thinking_guidance_uses_one_external_tool_anchor_only() {
    let mut payload = json!({
        "tools": [
            {"type":"function","name":"first","description":"first"},
            {"type":"function","name":"second","description":"second"},
            {"type":"function","name":"reasoningStop","description":"internal"},
            {"type":"function","name":"noop","description":"internal"}
        ]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject");
    assert!(payload["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains("工具调用协议"));
    assert_eq!(payload["tools"][1]["description"], "second");
    assert_eq!(payload["tools"][2]["description"], "internal");
    assert_eq!(payload["tools"][3]["description"], "internal");
}

#[test]
fn req04_tool_thinking_does_not_mutate_builtin_web_search_anchor() {
    let mut payload = json!({
        "tools": [
            {"type":"web_search","external_web_access":true,"description":null},
            {"type":"function","name":"pwd","description":"show cwd","parameters":{"type":"object"}}
        ]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject into an eligible native tool");
    assert_eq!(payload["tools"][0]["description"], Value::Null);
    assert!(payload["tools"][1]["description"]
        .as_str()
        .unwrap()
        .contains("工具调用协议"));
}

#[test]
fn req04_tool_thinking_guidance_is_not_injected_twice() {
    let mut payload = json!({"instructions":"client instructions"});
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject");
    let once = payload.clone();
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("repeated hook must remain idempotent");
    assert_eq!(payload, once);
}

#[test]
fn req04_tool_thinking_injects_into_canonical_chat_system_message() {
    let mut payload = json!({
        "messages": [
            {"role":"system","content":"Anthropic system instructions"},
            {"role":"user","content":"Call a tool"}
        ],
        "tools": [{"type":"function","name":"exec","description":"run"}]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject into canonical chat system");
    let content = payload["tools"][0]["description"].as_str().unwrap();
    assert!(content.contains("工具调用协议（只适用于本轮工具调用"));
    assert_eq!(payload["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn req04_tool_thinking_does_not_require_system_message() {
    let mut payload = json!({
        "messages": [{"role":"user","content":"Call a tool"}],
        "tools": [{"type":"function","name":"exec","description":"run"}]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("tool-list guidance must not require a system surface");
    assert!(payload["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains("工具调用协议"));
}

#[test]
fn req04_tool_thinking_injects_only_current_system_message() {
    let mut payload = json!({
        "messages": [
            {"role":"system","content":"historical system"},
            {"role":"user","content":"historical user"},
            {"role":"system","content":"current system"},
            {"role":"user","content":"Call a tool"}
        ],
        "tools": [{
            "type":"function",
            "name":"exec",
            "parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}
        }]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 2, true)
        .expect("current-turn tool-thinking guidance must inject");
    assert!(payload["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains("工具调用协议"));
    assert!(!payload["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("工具调用协议"));
    assert!(!payload["messages"][2]["content"]
        .as_str()
        .unwrap()
        .contains("工具调用协议"));
}

#[test]
fn req04_tool_thinking_prefers_responses_instructions_over_input_surface() {
    let mut payload = json!({
        "instructions": "original instructions",
        "input": [
            {"type": "message", "role": "system", "content": [{"type": "input_text", "text": "history system"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "old turn"}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "current turn"}]}
        ],
        "tools": [{"type":"function","name":"exec","description":"run"}]
    });
    let start = current_v3_tool_thinking_payload_start(&payload).expect("current Responses user");
    assert_eq!(start, 2);
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, start, true)
        .expect("enabled tool-thinking must inject");
    assert_eq!(payload["input"][0]["content"][0]["text"], "history system");
    assert_eq!(payload["input"].as_array().unwrap().len(), 3);
    assert!(payload["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains("工具调用协议"));
}

#[test]
fn req04_tool_thinking_does_not_require_responses_instructions() {
    let mut payload = json!({
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "current turn"}]}
        ],
        "tools": [{"type":"function","name":"exec","description":"run"}]
    });
    let start = current_v3_tool_thinking_payload_start(&payload).expect("current Responses user");
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, start, true)
        .expect("tool-list guidance must not require Responses instructions");
}

#[test]
fn req04_tool_thinking_reaches_anthropic_wire_system_field() {
    let mut payload = json!({
        "model": "glm-5.2",
        "messages": [
            {"role":"system","content":"Anthropic system instructions"},
            {"role":"user","content":"Call a tool"}
        ],
        "tools": [{"name":"pwd","description":"show cwd","input_schema":{"type":"object"}}]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject before Anthropic encoding");

    let wire = encode_v3_responses_semantic_as_anthropic_request(payload)
        .expect("canonical Chat payload must encode as Anthropic request");
    let tool_description = wire["tools"][0]["description"].to_string();
    assert!(
        tool_description.contains("工具调用协议（只适用于本轮工具调用"),
        "wire: {wire}"
    );
    assert!(
        tool_description.contains("goal_alignment_confidence"),
        "wire: {wire}"
    );
    assert!(tool_description.contains("model_id"), "wire: {wire}");
    assert!(!wire.to_string().contains("<legacy-control>"));
}

#[test]
fn req04_tool_thinking_injects_anthropic_tool_list_and_parameter_schema() {
    let mut payload = json!({
        "model": "MiniMax-M3",
        "system": "client system",
        "messages": [{"role":"user","content":"Call a tool"}],
        "tools": [{"name":"probe_tool","input_schema":{"type":"object"}}]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must inject into Anthropic system");
    assert!(payload["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains("goal_alignment_confidence"));
    assert!(payload["tools"][0]["description"]
        .as_str()
        .unwrap()
        .contains("model_id"));
    assert!(payload["tools"][0]["input_schema"]["properties"]["reason"].is_object());
    assert!(
        payload["tools"][0]["input_schema"]["properties"]["goal_alignment_confidence"].is_object()
    );
    assert!(payload["tools"][0]["input_schema"]["properties"]["model_id"].is_object());
    let required = payload["tools"][0]["input_schema"]["required"]
        .as_array()
        .unwrap();
    assert!(required.iter().any(|value| value.as_str() == Some("reason")));
    assert!(!required
        .iter()
        .any(|value| value.as_str() == Some("goal_alignment_confidence")));
    assert!(!required.iter().any(|value| value.as_str() == Some("model_id")));
}

#[test]
fn req04_tool_thinking_injects_every_present_native_schema_shape() {
    let mut payload = json!({
        "tools": [{
            "name": "probe_tool",
            "input_schema": {"type":"object"},
            "parameters": {"type":"object"},
            "function": {"parameters": {"type":"object"}}
        }]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("enabled tool-thinking must cover every native schema container");
    for schema in [
        &payload["tools"][0]["input_schema"],
        &payload["tools"][0]["parameters"],
        &payload["tools"][0]["function"]["parameters"],
    ] {
        for field in ["reason", "goal_alignment_confidence", "model_id"] {
            assert!(schema["properties"][field].is_object(), "schema={schema}");
        }
        assert!(schema["required"].as_array().is_some_and(|required| required
            .iter()
            .any(|value| value.as_str() == Some("reason"))));
        assert!(!schema["required"].as_array().is_some_and(|required| required
            .iter()
            .any(|value| value.as_str() == Some("goal_alignment_confidence"))));
        assert!(!schema["required"].as_array().is_some_and(|required| required
            .iter()
            .any(|value| value.as_str() == Some("model_id"))));
    }
}

#[test]
fn req04_tool_thinking_recurses_into_namespace_tools_before_provider_flattening() {
    let mut payload = json!({
        "tools": [{
            "type": "namespace",
            "name": "mcp__example",
            "tools": [{
                "type": "function",
                "name": "apply_patch",
                "parameters": {
                    "type": "object",
                    "properties": {"input": {"type": "string"}},
                    "required": ["input"]
                }
            }]
        }]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("namespace child schema must be governed at Req04");
    let schema = &payload["tools"][0]["tools"][0]["parameters"];
    assert!(schema["properties"]["reason"].is_object());
    assert!(schema["properties"]["goal_alignment_confidence"].is_object());
    assert!(schema["properties"]["model_id"].is_object());
    assert!(schema["required"]
        .as_array()
        .is_some_and(|required| required.iter().any(|value| value == "reason")));
}

#[test]
fn req04_tool_thinking_custom_tool_compiles_provider_wrapper() {
    let mut payload = json!({
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "description": "raw patch",
            "format": {"type":"text"}
        }]
    });
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("custom tool guidance must inject");
    assert_eq!(payload["tools"][0]["type"], "function");
    assert_eq!(payload["tools"][0]["function"]["name"], "apply_patch");
    let parameters = &payload["tools"][0]["function"]["parameters"];
    assert_eq!(parameters["properties"]["input"]["type"], "string");
    assert_eq!(parameters["properties"]["reason"]["type"], "string");
    assert!(parameters["required"]
        .as_array()
        .is_some_and(|required| required.iter().any(|value| value == "input")));
    assert!(parameters["required"]
        .as_array()
        .is_some_and(|required| required.iter().any(|value| value == "reason")));
}

#[test]
fn req04_tool_thinking_disabled_is_payload_identity() {
    let mut payload = json!({"tools":[{"type":"function","name":"exec","description":"run"}]});
    let before = payload.clone();
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, false)
        .expect("disabled tool-thinking must be a no-op");
    assert_eq!(payload, before);
}

#[test]
fn req04_tool_thinking_preserves_native_reserved_field_collision_without_mutation() {
    let mut payload = json!({
        "tools": [{
            "type": "function",
            "name": "native_reason_tool",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {"type":"string", "description":"native meaning"},
                    "path": {"type":"string"}
                },
                "required": ["path"]
            }
        }]
    });
    let before_schema = payload["tools"][0]["parameters"].clone();
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("native business fields must not make the request fail");
    assert_eq!(payload["tools"][0]["parameters"], before_schema);
}

#[test]
fn req04_tool_thinking_does_not_modify_tool_declarations() {
    let mut payload = json!({
        "tools":[{"function_declarations":[{"name":"lookup","description":"find data"}]}]
    });
    let before = payload.clone();
    inject_v3_tool_thinking_guidance_at_req04(&mut payload, 0, true)
        .expect("Gemini request must remain valid when JSON guidance is excluded");
    assert_eq!(payload, before);
}

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
