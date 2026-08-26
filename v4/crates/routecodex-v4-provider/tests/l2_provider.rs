//! routecodex-v4-provider L2 regression: session-scoped availability.

use routecodex_v4_provider::{
    build_anthropic_messages_wire, build_openai_chat_wire, build_protocol_wire,
    load_profile, normalize_provider_response, normalize_provider_sse_frame, send_openai_chat,
    validate_auth_alias, verify_profile_auth, AvailabilityRecord, AvailabilityState,
    V4Availability01SessionScoped,
};
use serde_json::json;
use std::fs;

#[test]
fn session_scoped_availability_positive_and_red() {
    let mut registry = V4Availability01SessionScoped::new();
    registry
        .record(
            "srv-1",
            "rg-1",
            "session-a",
            "provider-1",
            AvailabilityState::Healthy,
            0,
        )
        .expect("record must succeed");
    let record: &AvailabilityRecord = registry
        .get("srv-1", "rg-1", "session-a", "provider-1")
        .expect("session record must exist");
    assert_eq!(record.state, AvailabilityState::Healthy);
    registry
        .record(
            "srv-1",
            "rg-1",
            "session-a",
            "provider-1",
            AvailabilityState::Unavailable,
            3,
        )
        .expect("same-session update must replace the record");
    assert_eq!(
        registry
            .get("srv-1", "rg-1", "session-a", "provider-1")
            .expect("updated record")
            .consecutive_errors,
        3
    );
    // Different session must never observe the other session's availability.
    assert!(registry
        .get("srv-1", "rg-1", "session-b", "provider-1")
        .is_none());
    assert_eq!(registry.records().count(), 1);
    registry
        .mark_failure("srv-1", "rg-1", "session-a", "provider-1", true, 4)
        .expect("cooldown failure records");
    assert!(!registry.is_eligible("srv-1", "rg-1", "session-a", "provider-1"));
    assert!(registry.is_eligible("srv-1", "rg-1", "session-b", "provider-1"));
    registry
        .mark_success("srv-1", "rg-1", "session-a", "provider-1")
        .expect("success clears cooldown");
    assert!(registry.is_eligible("srv-1", "rg-1", "session-a", "provider-1"));
}

#[test]
fn secret_file_requires_and_resolves_exact_secret_key() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let secrets = root.join("secrets.toml");
    fs::write(&secrets, "[provider]\nkey1 = \"real-secret\"\n").expect("secret file");
    let profile_path = root.join("provider.toml");
    let profile = format!(
        "providerId = \"real\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\n[provider.models.wire]\nwireName = \"wire\"\n[provider.auth]\nentries = [{{ alias = \"key1\", secretFile = \"{}\", secretKey = \"provider.key1\" }}]\n",
        secrets.display()
    );
    fs::write(&profile_path, profile).expect("profile");
    let loaded = load_profile(profile_path.to_str().expect("utf8 path")).expect("load profile");
    verify_profile_auth(&loaded).expect("exact key resolves");
}

#[test]
fn secret_file_without_secret_key_fails_fast() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-invalid-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let profile_path = root.join("provider.toml");
    fs::write(
        &profile_path,
        "providerId = \"real\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\n[provider.models.wire]\nwireName = \"wire\"\n[provider.auth]\nentries = [{ alias = \"key1\", secretFile = \"/tmp/secrets.toml\" }]\n",
    )
    .expect("profile");
    let error = load_profile(profile_path.to_str().expect("utf8 path")).expect_err("must fail");
    assert_eq!(error.code, "provider_auth_handle_invalid");
}

#[test]
fn v3_provider_profile_reads_secret_file_handle_without_runtime_import() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-v3-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let secrets = root.join("secrets.conf");
    fs::write(&secrets, "real.key1 = real-secret\n").expect("secret file");
    let profile_path = root.join("provider.v2.toml");
    let profile = format!(
        "version = \"2.0.0\"\nproviderId = \"real\"\n[provider]\nid = \"real\"\ntype = \"responses\"\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\n[provider.models.wire]\ncapabilities = [\"text\"]\n[provider.auth]\ntype = \"apikey\"\nsecretFile = \"{}\"\n",
        secrets.display()
    );
    fs::write(&profile_path, profile).expect("profile");
    let loaded = load_profile(profile_path.to_str().expect("utf8 path")).expect("load v3 profile");
    verify_profile_auth(&loaded).expect("v3 secret handle resolves");
}

#[test]
fn compiled_auth_alias_is_checked_before_transport() {
    let root = std::env::temp_dir().join(format!("rccv4-provider-alias-{}", std::process::id()));
    fs::create_dir_all(&root).expect("temp root");
    let profile_path = root.join("provider.toml");
    fs::write(
        &profile_path,
        "providerId = \"real\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"responses\"\n[provider.auth]\nentries = [{ alias = \"default\", secretFile = \"/tmp/secrets.conf\", secretKey = \"real.key1\" }]\n",
    )
    .expect("profile");
    let path = profile_path.to_str().expect("utf8 path");
    validate_auth_alias(path, Some("default")).expect("matching alias");
    let error = validate_auth_alias(path, Some("key2")).expect_err("mismatched alias");
    assert_eq!(error.code, "provider_auth_alias_mismatch");
}

#[test]
fn openai_chat_wire_sets_wire_model_without_control_fields() {
    let wire = build_openai_chat_wire(
        &json!({"messages":[{"role":"user","content":"hello"}],"stream":false}),
        "gpt-wire",
        false,
    )
    .expect("chat wire");
    assert_eq!(wire["model"], "gpt-wire");
    assert_eq!(wire["messages"][0]["content"], "hello");
    assert!(wire.get("metadata").is_none());
}

#[test]
fn anthropic_wire_requires_messages_and_rejects_missing_shape() {
    let wire = build_anthropic_messages_wire(
        &json!({"messages":[{"role":"user","content":"hello"}],"max_tokens":128}),
        "claude-wire",
        false,
    )
    .expect("anthropic wire");
    assert_eq!(wire["model"], "claude-wire");
    assert_eq!(wire["max_tokens"], 128);
    assert!(build_anthropic_messages_wire(&json!({"input": []}), "claude-wire", false).is_err());
}

#[test]
fn protocol_dispatch_projects_normalized_input_to_selected_wire_shape() {
    let input = json!({"input":[{"role":"user","content":"hello"}],"max_output_tokens":64});
    let openai = build_protocol_wire("openai", &input, "gpt-wire", false).expect("openai wire");
    assert!(openai.get("input").is_none());
    assert_eq!(openai["messages"][0]["content"], "hello");
    let anthropic = build_protocol_wire("anthropic", &input, "claude-wire", false)
        .expect("anthropic wire");
    assert_eq!(anthropic["max_tokens"], 64);
    assert!(build_protocol_wire("unknown", &input, "wire", false).is_err());
}

#[test]
fn protocol_transport_rejects_profile_protocol_mismatch_before_network() {
    let path = std::env::temp_dir().join(format!("rccv4-provider-protocol-{}.toml", std::process::id()));
    fs::write(
        &path,
        "providerId = \"real\"\n[provider]\nbaseURL = \"https://example.invalid/v1\"\ndefaultModel = \"wire\"\ntype = \"anthropic\"\n[provider.auth]\nenv = \"RCCV4_TEST_KEY\"\n",
    )
    .expect("profile");
    let error = send_openai_chat(path.to_str().expect("utf8 path"), &json!({"messages":[]}))
        .expect_err("protocol mismatch");
    assert_eq!(error.code, "provider_protocol_mismatch");
}

#[test]
fn provider_response_normalizers_preserve_text_tools_and_usage() {
    let openai = normalize_provider_response(
        "openai",
        &json!({
            "id":"chat-1","model":"gpt-wire",
            "choices":[{"message":{"content":"hello","tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]}}],
            "usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}
        }),
    )
    .expect("openai normalized");
    assert_eq!(openai["status"], "completed");
    assert_eq!(openai["output"][0]["content"][0]["text"], "hello");
    assert_eq!(openai["output"][1]["call_id"], "call-1");
    assert_eq!(openai["usage"]["input_tokens"], 3);
    let anthropic = normalize_provider_response(
        "anthropic",
        &json!({"id":"msg-1","model":"claude-wire","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":2,"output_tokens":5}}),
    )
    .expect("anthropic normalized");
    assert_eq!(anthropic["output"][0]["content"][0]["text"], "hello");
    assert_eq!(anthropic["usage"]["total_tokens"], 7);
    assert!(normalize_provider_response("anthropic", &json!({"content":[]})).is_ok());
}

#[test]
fn responses_normalizer_consumes_gateway_diagnostics_before_client_projection() {
    let normalized = normalize_provider_response(
        "responses",
        &json!({
            "id": "resp-1",
            "status": "completed",
            "output": [],
            "extra_fields": {
                "provider": "openai",
                "provider_response_headers": {"x-request-id": "upstream"},
                "latency": 12,
                "resolved_model_used": "gpt-wire"
            }
        }),
    )
    .expect("known gateway diagnostics are consumed at provider boundary");
    assert!(normalized.get("extra_fields").is_none());
    assert_eq!(normalized["id"], "resp-1");
}

#[test]
fn responses_normalizer_rejects_unknown_gateway_diagnostics() {
    let error = normalize_provider_response(
        "responses",
        &json!({
            "id": "resp-1",
            "status": "completed",
            "output": [],
            "extra_fields": {"unregistered_control": true}
        }),
    )
    .expect_err("unknown control fields must fail closed");
    assert_eq!(error.code, "provider_response_control_envelope");
}

#[test]
fn provider_sse_normalizers_project_text_and_terminal_events() {
    let openai = normalize_provider_sse_frame(
        "openai",
        b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n",
    )
    .expect("openai sse normalized");
    let text = String::from_utf8(openai).expect("utf8");
    assert!(text.contains("response.output_text.delta"));
    assert!(text.contains("response.completed"));
    let anthropic = normalize_provider_sse_frame(
        "anthropic",
        b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    )
    .expect("anthropic sse normalized");
    assert!(String::from_utf8(anthropic).expect("utf8").contains("response.completed"));
}
