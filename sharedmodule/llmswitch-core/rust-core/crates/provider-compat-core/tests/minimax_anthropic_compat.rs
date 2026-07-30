use provider_compat_core::req_outbound_stage3_compat::{
    run_req_outbound_stage3_compat, AdapterContext, ReqOutboundCompatInput,
};
use serde_json::{json, Value};

fn run(payload: Value) -> Result<Value, String> {
    run_req_outbound_stage3_compat(ReqOutboundCompatInput {
        payload,
        adapter_context: AdapterContext {
            compatibility_profile: Some("chat:minimax".to_string()),
            provider_protocol: Some("anthropic-messages".to_string()),
            ..Default::default()
        },
        explicit_profile: None,
    })
    .map(|result| result.payload)
}

#[test]
fn projects_hosted_web_search_to_function_pair() {
    let result = run(json!({
        "model":"MiniMax-M3",
        "tools":[{"type":"web_search_20250305","name":"web_search"}],
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use",
                "id":"call_routecodex_web_search_5",
                "name":"web_search",
                "input":{"type":"search","query":"Ubuntu ARM64"}
            },{
                "type":"web_search_tool_result",
                "tool_use_id":"call_routecodex_web_search_5",
                "content":[]
            }]
        }]
    }))
    .unwrap();

    assert_eq!(result["tools"][0]["name"], json!("web_search"));
    assert_eq!(
        result["tools"][0]["input_schema"]["properties"]["query"]["type"],
        json!("string")
    );
    assert_eq!(
        result["messages"][0]["content"][0]["type"],
        json!("tool_use")
    );
    assert_eq!(result["messages"][1]["role"], json!("user"));
    assert_eq!(
        result["messages"][1]["content"][0]["type"],
        json!("tool_result")
    );
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(!serialized.contains("server_tool_use"));
    assert!(!serialized.contains("web_search_tool_result"));
    assert!(!serialized.contains("web_search_20250305"));
}

#[test]
fn converts_hosted_result_and_string_user_content() {
    let result = run(json!({
        "model":"MiniMax-M3",
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use",
                "id":"call_routecodex_web_search_5",
                "name":"web_search",
                "input":{"type":"search","query":"Ubuntu ARM64","ignored":"provider-specific"}
            },{
                "type":"web_search_tool_result",
                "tool_use_id":"call_routecodex_web_search_5",
                "content":[{
                    "type":"web_search_result",
                    "url":"https://example.test",
                    "title":"Example",
                    "encrypted_content":"cipher"
                }]
            }]
        },{
            "role":"user",
            "content":"continue"
        }]
    }))
    .unwrap();

    assert_eq!(
        result["messages"][0]["content"][0]["input"],
        json!({"query":"Ubuntu ARM64"})
    );
    assert_eq!(
        result["messages"][1]["content"][0]["content"][0]["type"],
        json!("text")
    );
    assert!(result["messages"][1]["content"][0]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("encrypted_content"));
    assert_eq!(
        result["messages"][1]["content"][1],
        json!({"type":"text","text":"continue"})
    );
}

#[test]
fn marks_failed_hosted_result_as_tool_error() {
    let result = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use",
                "id":"ws1",
                "name":"web_search",
                "input":{"type":"search","query":"q"}
            },{
                "type":"web_search_tool_result",
                "tool_use_id":"ws1",
                "content":{"status":"failed","error":{"code":"boom"}}
            }]
        }]
    }))
    .unwrap();
    assert_eq!(result["messages"][1]["content"][0]["is_error"], json!(true));
}

#[test]
fn rejects_duplicate_hosted_ids_across_messages() {
    let error = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Ubuntu ARM64"}
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_5","content":[]
            }]
        },{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Debian ARM64"}
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_5","content":[]
            }]
        }]
    }))
    .expect_err("duplicate hosted ids across request must fail before provider send");
    assert!(error.contains("is duplicated"));
}

#[test]
fn rejects_duplicate_ids_across_ordinary_and_hosted_tool_calls() {
    let error = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"tool_use","id":"same","name":"exec","input":{}
            },{
                "type":"server_tool_use","id":"same","name":"web_search","input":{"type":"search","query":"q"}
            },{
                "type":"web_search_tool_result","tool_use_id":"same","content":[]
            }]
        }]
    }))
    .expect_err("cross-type duplicate ids must fail before provider send");
    assert!(error.contains("same"));
    assert!(error.contains("duplicated"));
}

#[test]
fn rejects_malformed_hosted_tool_declarations() {
    for payload in [
        json!({"tools":[{"type":"web_search_20250305"}]}),
        json!({"tools":[{"type":"web_search_20250305","name":"not_web"}]}),
        json!({"tools":[{"type":"web_search_20990101","name":"web_search"}]}),
        json!({"tools":[{"type":"web_search_20250305","name":"web_search","allowed_domains":["example.com"]}]}),
    ] {
        run(payload).expect_err("malformed hosted web-search tool must fail");
    }
}

#[test]
fn rejects_unrepresentable_hosted_action() {
    let error = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"open_page","url":"https://example.test"}
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_5","content":[]
            }]
        }]
    }))
    .expect_err("MiniMax ordinary web_search tool requires query input");
    assert!(error.contains("call input query is required"));
}

#[test]
fn rejects_orphan_hosted_web_search_result() {
    let error = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Ubuntu ARM64"}
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_missing","content":[]
            }]
        }]
    }))
    .expect_err("orphan hosted web-search result must fail before provider send");
    assert!(error.contains("has no matching server call"));
}

#[test]
fn rejects_unmatched_hosted_web_search_call() {
    let error = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Ubuntu ARM64"}
            }]
        }]
    }))
    .expect_err("hosted web-search call without result must fail before provider send");
    assert!(error.contains("calls and results must match exactly"));
}

#[test]
fn rejects_missing_hosted_web_search_fields() {
    let missing_input = json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search"
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_5","content":[]
            }]
        }]
    });
    let missing_content = json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Ubuntu ARM64"}
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_5"
            }]
        }]
    });

    let input_error = run(missing_input)
        .expect_err("missing hosted web-search input must fail before provider send");
    assert!(input_error.contains("call input object is required"));
    let content_error = run(missing_content)
        .expect_err("missing hosted web-search result content must fail before provider send");
    assert!(content_error.contains("result content is required"));
}

#[test]
fn rejects_malformed_collections() {
    for payload in [
        json!({"model":"MiniMax-M3","tools":{}}),
        json!({"model":"MiniMax-M3","messages":{}}),
    ] {
        run(payload)
            .expect_err("malformed MiniMax Anthropic collections must fail before provider send");
    }
}
