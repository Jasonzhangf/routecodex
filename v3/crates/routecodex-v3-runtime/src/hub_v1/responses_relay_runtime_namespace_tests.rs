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
fn ambiguous_codex_tool_leaf_does_not_gain_a_guessed_namespace() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
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
    .expect("ambiguous function leaf remains a valid provider response");

    assert!(response["output"][0].get("namespace").is_none());
    assert_eq!(response["output"][0]["name"], "exec");
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
