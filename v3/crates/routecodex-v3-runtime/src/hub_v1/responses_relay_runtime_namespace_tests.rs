use super::*;
use serde_json::json;

#[test]
fn codex_namespaced_exec_tool_call_restores_namespace_for_client_dispatch() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "choices":[{
                "message":{
                    "role":"assistant",
                    "tool_calls":[{
                        "id":"call_exec_1",
                        "type":"function",
                        "function":{"name":"exec","arguments":"{\"input\":\"text(1+1)\\n\"}"}
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        }),
        &json!({
            "input":[{
                "role":"developer",
                "type":"additional_tools",
                "tools":[{
                    "name":"functions",
                    "tools":[{"name":"exec","parameters":{"type":"object"}}]
                }]
            }]
        }),
    )
    .expect("Codex exec function call should project to its declared namespace");

    assert_eq!(response["status"], "requires_action");
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["namespace"], "functions");
    assert_eq!(response["output"][0]["name"], "exec");
    assert_eq!(response["output"][0]["call_id"], "call_exec_1");
    assert_eq!(
        response["output"][0]["arguments"],
        r#"{"input":"text(1+1)\n"}"#
    );
}

#[test]
fn ambiguous_codex_tool_leaf_fails_before_client_dispatch() {
    let error = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "choices":[{"message":{"role":"assistant","tool_calls":[{
                "id":"call_exec_2",
                "type":"function",
                "function":{"name":"exec","arguments":"{}"}
            }]},"finish_reason":"tool_calls"}]
        }),
        &json!({"input":[
            {"role":"developer","type":"additional_tools","tools":[{"name":"functions","tools":[{"name":"exec"}]}]},
            {"role":"developer","type":"additional_tools","tools":[{"name":"other","tools":[{"name":"exec"}]}]}
        ]}),
    )
    .expect_err("ambiguous function leaf must not dispatch a guessed tool");

    assert!(error.to_string().contains("multiple declared functions"));

    let error = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({"choices":[{"message":{"role":"assistant","tool_calls":[{
            "id":"call_exec_root_collision","type":"function",
            "function":{"name":"exec","arguments":"{}"}
        }]},"finish_reason":"tool_calls"}]}),
        &json!({"input":[{"type":"additional_tools","tools":[
            {"type":"function","name":"exec"},
            {"type":"namespace","name":"functions","tools":[{"type":"function","name":"exec"}]}
        ]}]}),
    )
    .expect_err("top-level and namespaced function leaf must not guess a dispatch target");
    assert!(error.to_string().contains("multiple declared functions"));
}

#[test]
fn custom_tool_leaf_collision_fails_instead_of_dispatching_the_wrong_tool() {
    let provider_response = json!({
        "choices":[{"message":{"role":"assistant","tool_calls":[{
            "id":"call_exec_collision",
            "type":"function",
            "function":{"name":"exec","arguments":"{\"input\":\"text(1)\"}"}
        }]},"finish_reason":"tool_calls"}]
    });
    let two_custom_tools = json!({"input":[{"type":"additional_tools","tools":[
        {"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]},
        {"type":"namespace","name":"other","tools":[{"type":"custom","name":"exec"}]}
    ]}]});
    let error = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_response,
        &two_custom_tools,
    )
    .expect_err("ambiguous custom leaf must not silently select a client tool");
    assert!(error.to_string().contains("multiple declared custom tools"));

    let custom_and_function = json!({"input":[{"type":"additional_tools","tools":[
        {"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]},
        {"type":"namespace","name":"other","tools":[{"type":"function","name":"exec"}]}
    ]}]});
    let error = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_response,
        &custom_and_function,
    )
    .expect_err("custom and function leaf collision must not change the declared kind");
    assert!(error
        .to_string()
        .contains("both custom and function declarations"));

    let custom_and_root_function = json!({"input":[{"type":"additional_tools","tools":[
        {"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec"}]},
        {"type":"function","name":"exec"}
    ]}]});
    let error = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_response,
        &custom_and_root_function,
    )
    .expect_err("top-level function must not be relabeled as namespaced custom");
    assert!(error
        .to_string()
        .contains("both custom and function declarations"));
}

#[test]
fn reserved_tool_search_leaf_does_not_override_declared_custom_tool() {
    let error = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({"choices":[{"message":{"role":"assistant","tool_calls":[{
            "id":"call_tool_search_collision","type":"function",
            "function":{"name":"tool_search","arguments":"{\"input\":\"text(1)\"}"}
        }]},"finish_reason":"tool_calls"}]}),
        &json!({"input":[{"type":"additional_tools","tools":[{
            "type":"namespace","name":"functions","tools":[{"type":"custom","name":"tool_search"}]
        }]}]}),
    )
    .expect_err("reserved leaf must not replace a declared custom tool");
    assert!(error.to_string().contains("reserved tool_search"));

    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({"choices":[{"message":{"role":"assistant","tool_calls":[{
            "id":"call_declared_tool_search","type":"function",
            "function":{"name":"tool_search","arguments":"{}"}
        }]},"finish_reason":"tool_calls"}]}),
        &json!({"input":[{"type":"additional_tools","tools":[{
            "type":"namespace","name":"functions","tools":[{"type":"function","name":"tool_search"}]
        }]}]}),
    )
    .expect("declared function must retain its function kind");
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["namespace"], "functions");
    assert_eq!(response["output"][0]["name"], "tool_search");
}

#[test]
fn already_qualified_custom_child_keeps_declared_identity() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({"choices":[{"message":{"role":"assistant","tool_calls":[{
            "id":"call_qualified_exec","type":"function",
            "function":{"name":"functions__exec","arguments":"{\"input\":\"text(1)\"}"}
        }]},"finish_reason":"tool_calls"}]}),
        &json!({"input":[{"type":"additional_tools","tools":[{
            "type":"namespace","name":"functions","tools":[{"type":"custom","name":"functions__exec"}]
        }]}]}),
    )
    .expect("qualified custom child must retain its declared namespace");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["namespace"], "functions");
    assert_eq!(response["output"][0]["name"], "functions__exec");

    let canonical = crate::hub_v1::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
        &json!({"model":"gpt-6-luna","input":[
            response["output"][0].clone(),
            {"type":"custom_tool_call_output","call_id":"call_qualified_exec","output":"2"}
        ]}),
    )
    .expect("qualified custom call and output must normalize together");
    let provider_request = crate::hub_v1::request_outbound_format::build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("qualified custom history must project to OpenAI Chat");
    assert_eq!(
        provider_request["messages"][0]["tool_calls"][0]["function"]["name"],
        "functions__exec"
    );
}
