use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use serde_json::json;

#[test]
fn openai_chat_visible_zero_output_text_with_real_usage_remains_success() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_visible_text",
            "model": "glm-5.2",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "upstream returned zero output tokens is only quoted text here"
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 9,
                "total_tokens": 21
            }
        }),
        &json!({"tools":[]}),
    )
    .expect("visible content with real usage must stay a valid response");

    assert_eq!(response["status"], "completed");
    assert_eq!(
        response["output"][0]["text"],
        "upstream returned zero output tokens is only quoted text here"
    );
}

#[test]
fn multi_interface_selected_interface_has_responses_contract() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.multi]
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MULTI_KEY" }] }

[providers.multi.models.gpt-test]
capabilities = ["text"]
supports_streaming = true

[providers.multi.interfaces.responses]
type = "responses"
base_url = "https://multi.invalid/v1"
responses = { process = "chat", streaming = "always", transport = "http" }

[providers.multi.interfaces.chat]
type = "openai_chat"
base_url = "https://multi.invalid/chat/v1"

[route_groups.default.pools.default]
targets = [{ kind = "provider_model", provider = "multi", model = "gpt-test", key = "key1", priority = 1 }]
"#,
        )
        .expect("parse multi-interface manifest"),
    )
    .expect("compile multi-interface manifest");
    assert_eq!(manifest.providers["multi"].interfaces.len(), 2);
    assert!(selected_interface_has_responses_contract(
        &manifest,
        "multi",
        "responses"
    ));
    assert!(!selected_interface_has_responses_contract(
        &manifest, "multi", "chat"
    ));
}
