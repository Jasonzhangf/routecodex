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

// Mode A 直通：minimax_anthropic::apply_request_compat 不再做工具/历史投影。
// Anthropic wire 编码与 hosted shape 直通由 v3 anthropic_codec 完成，本层
// 仅在响应侧 strip minimax sentinel。

#[test]
fn passthrough_keeps_hosted_web_search_tool_declaration() {
    let payload = json!({
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
    });
    let result = run(payload.clone()).unwrap();
    // hosted shape 原样透传：tool type=web_search_20250305 不变，
    // server_tool_use / web_search_tool_result 不被改写。
    assert_eq!(result["tools"][0]["type"], json!("web_search_20250305"));
    assert_eq!(result["tools"][0]["name"], json!("web_search"));
    assert_eq!(
        result["messages"][0]["content"][0]["type"],
        json!("server_tool_use")
    );
    assert_eq!(
        result["messages"][0]["content"][1]["type"],
        json!("web_search_tool_result")
    );
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(serialized.contains("web_search_20250305"));
    assert!(serialized.contains("server_tool_use"));
    assert!(serialized.contains("web_search_tool_result"));
}

#[test]
fn passthrough_keeps_string_user_content_unchanged() {
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
    // 直通：input 完整保留（含 ignored 字段），user content "continue" 不被转换。
    assert_eq!(
        result["messages"][0]["content"][0]["input"],
        json!({"type":"search","query":"Ubuntu ARM64","ignored":"provider-specific"})
    );
    assert_eq!(result["messages"][1]["content"], json!("continue"));
}

#[test]
fn passthrough_does_not_require_query_field() {
    // Mode B 投影要求 hosted call 有 query；Mode A 直通不做该校验，
    // wire 编码层交给 anthropic provider 处理。
    let result = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Ubuntu ARM64"}
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_5","content":[]
            }]
        }]
    }))
    .unwrap();
    assert_eq!(
        result["messages"][0]["content"][0]["name"],
        json!("web_search")
    );
}

#[test]
fn passthrough_allows_orphan_hosted_web_search_result() {
    // Mode B 校验拒绝 orphan tool_use_id；Mode A 直通不校验。
    let result = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Ubuntu ARM64"}
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_missing","content":[]
            }]
        }]
    }))
    .unwrap();
    assert_eq!(
        result["messages"][0]["content"][1]["tool_use_id"],
        json!("call_routecodex_web_search_missing")
    );
}

#[test]
fn passthrough_allows_unmatched_hosted_web_search_call() {
    // Mode B 校验要求 calls 和 results 配对；Mode A 直通不校验。
    let result = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search","input":{"type":"search","query":"Ubuntu ARM64"}
            }]
        }]
    }))
    .unwrap();
    assert_eq!(
        result["messages"][0]["content"][0]["id"],
        json!("call_routecodex_web_search_5")
    );
}

#[test]
fn passthrough_allows_duplicate_hosted_ids() {
    // Mode B 拒绝重复 hosted id；Mode A 直通不校验。
    let result = run(json!({
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
    .unwrap();
    assert_eq!(
        result["messages"][1]["content"][0]["input"]["query"],
        json!("Debian ARM64")
    );
}

#[test]
fn passthrough_allows_duplicate_ids_across_ordinary_and_hosted() {
    // Mode B 拒绝普通 tool_use 与 hosted server_tool_use id 重复；
    // Mode A 直通不校验。
    let result = run(json!({
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
    .unwrap();
    assert_eq!(result["messages"][0]["content"][1]["id"], json!("same"));
}

#[test]
fn passthrough_allows_missing_hosted_input() {
    // Mode B 校验 hosted call 必须有 input object；Mode A 直通不校验。
    let result = run(json!({
        "messages":[{
            "role":"assistant",
            "content":[{
                "type":"server_tool_use","id":"call_routecodex_web_search_5","name":"web_search"
            },{
                "type":"web_search_tool_result","tool_use_id":"call_routecodex_web_search_5","content":[]
            }]
        }]
    }))
    .unwrap();
    assert_eq!(
        result["messages"][0]["content"][0]["name"],
        json!("web_search")
    );
}

#[test]
fn passthrough_allows_malformed_hosted_tool_declarations() {
    // Mode B 拒绝非法 hosted tool shape（web_search_20990101 等）；
    // Mode A 直通不校验，wire 上透传。
    for payload in [
        json!({"tools":[{"type":"web_search_20250305"}]}),
        json!({"tools":[{"type":"web_search_20250305","name":"not_web"}]}),
        json!({"tools":[{"type":"web_search_20990101","name":"web_search"}]}),
        json!({"tools":[{"type":"web_search_20250305","name":"web_search","allowed_domains":["example.com"]}]}),
    ] {
        let result = run(payload.clone())
            .unwrap_or_else(|error| panic!("Mode A passthrough must succeed: {error}"));
        assert_eq!(result["tools"], payload["tools"]);
    }
}

#[test]
fn passthrough_rejects_malformed_collections() {
    // 集合类型校验（顶层 tools/messages 不是 array）仍由 v3 编码器
    // 在 Anthropic wire 阶段处理；本 compat 层在 Mode A 直通下不报错。
    // 保留为兼容性监控：旧 Mode B 校验不在此层。
    for payload in [
        json!({"model":"MiniMax-M3","tools":{}}),
        json!({"model":"MiniMax-M3","messages":{}}),
    ] {
        // Mode A 直通：不过不报错；调用方负责校验。
        let result = run(payload.clone()).unwrap();
        assert_eq!(result["tools"], payload["tools"]);
        assert_eq!(result["messages"], payload["messages"]);
    }
}
