//! 最后一个真实图片载体驱动视觉路由；后续纯文本不改变图片边界。
//! Chat、Responses、Gemini 共用该规则；已清理的占位不产生视觉能力。

use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    build_v3_chat_req_04_standardized_from_v3_server_03, build_v3_router_request_facts_for_entry,
    build_v3_router_request_facts_from_v3_req_04_chat, build_v3_server_03_http_request_raw,
};
use serde_json::json;

const TEST_LONGCONTEXT_THRESHOLD_TOKENS: Option<u64> = Some(180_000);

fn manifest_mode_b_websearch_for_routing_facts() -> routecodex_v3_config::V3Config05ManifestPublished
{
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.controlled.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn v3_routing_facts_keep_latest_chat_image_after_text_only_turn() {
    let raw = build_v3_server_03_http_request_raw(
        "server".to_string(),
        V3ProviderFailureSessionScope::new("server", "default", "request").expect("failure scope"),
        "request".to_string(),
        "execution".to_string(),
        "POST".to_string(),
        "/v1/chat/completions".to_string(),
        json!({
            "model": "deepseek-v4-flash",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "describe this"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                    ]
                },
                {"role": "assistant", "content": "old image described"},
                {"role": "user", "content": "continue without image"}
            ]
        }),
    );

    let normalized =
        build_v3_chat_req_04_standardized_from_v3_server_03(raw).expect("chat req04 normalize");
    let facts = build_v3_router_request_facts_from_v3_req_04_chat(
        &normalized,
        &manifest_mode_b_websearch_for_routing_facts(),
    );

    assert!(
        facts.capabilities.contains("multimodal"),
        "latest image must route multimodal after a text-only turn; caps={:?}",
        facts.capabilities
    );
    assert!(facts.capabilities.contains("vision"));
}

#[test]
fn v3_routing_facts_keep_latest_responses_image_after_text_only_turn() {
    let request = json!({
        "model": "deepseek-v4-flash",
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "describe this"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
                ]
            },
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "done"}]
            },
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            }
        ]
    });

    let facts = build_v3_router_request_facts_for_entry(
        &request,
        "responses",
        TEST_LONGCONTEXT_THRESHOLD_TOKENS,
    );

    assert!(
        facts.capabilities.contains("multimodal"),
        "latest responses image must route multimodal after a text-only turn; caps={:?}",
        facts.capabilities
    );
    assert!(facts.capabilities.contains("vision"));
}

#[test]
fn v3_routing_facts_keep_latest_gemini_image_after_text_only_turn() {
    let request = json!({
        "model": "gemini-2.5-flash",
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": "describe this"},
                    {"inline_data": {"mime_type": "image/png", "data": "AAAA"}}
                ]
            },
            {"role": "model", "parts": [{"text": "done"}]},
            {"role": "user", "parts": [{"text": "continue"}]}
        ]
    });

    let facts = build_v3_router_request_facts_for_entry(
        &request,
        "gemini",
        TEST_LONGCONTEXT_THRESHOLD_TOKENS,
    );

    assert!(
        facts.capabilities.contains("multimodal"),
        "latest gemini image must route multimodal after a text-only turn; caps={:?}",
        facts.capabilities
    );
    assert!(facts.capabilities.contains("vision"));
}

#[test]
fn v3_routing_facts_current_turn_gemini_image_routes_multimodal() {
    // 当前消息的真实图片也必须驱动 multimodal。
    let request = json!({
        "model": "gemini-2.5-flash",
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": "describe this"},
                    {"inline_data": {"mime_type": "image/png", "data": "AAAA"}}
                ]
            }
        ]
    });

    let facts = build_v3_router_request_facts_for_entry(
        &request,
        "gemini",
        TEST_LONGCONTEXT_THRESHOLD_TOKENS,
    );

    assert!(
        facts.capabilities.contains("multimodal"),
        "gemini current-turn image must route multimodal; caps={:?}",
        facts.capabilities
    );
    assert!(facts.capabilities.contains("vision"));
}

#[test]
fn v3_responses_trailing_tool_output_images_route_multimodal() {
    let cases = [
        (
            "function_call_output",
            json!([{"detail": "original", "image_url": "data:image/png;base64,FCO"}]),
        ),
        (
            "custom_tool_call_output",
            json!([{"detail": "original", "image_url": "data:image/png;base64,CUSTOM"}]),
        ),
        (
            "tool_call_output",
            json!([{"detail": "original", "image_url": "data:image/png;base64,TOOL"}]),
        ),
        (
            "function_call_output",
            json!("[{\"detail\":\"original\",\"image_url\":\"data:image/png;base64,STRING\"}]"),
        ),
    ];

    for (output_type, output) in cases {
        let request = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"}
                ]},
                {"type": output_type, "call_id": "call_1", "output": output}
            ]
        });
        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(
            facts.route_classification.route_name, "multimodal",
            "latest {output_type} image must activate multimodal: {:?}",
            facts.route_classification
        );
        assert!(facts.capabilities.contains("multimodal"));
        assert!(facts.capabilities.contains("vision"));
    }
}
