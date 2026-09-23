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
