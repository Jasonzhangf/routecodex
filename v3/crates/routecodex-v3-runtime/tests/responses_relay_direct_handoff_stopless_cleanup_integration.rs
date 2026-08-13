// Red-to-green: Relay Req04 注入 stopless 合约后 handoff 到 SameProtocolDirect，
// handoff payload 必须撤销当前轮 relay 注入的 stopless 合约（reasoningStop tool、
// 推进准则、tool_choice），由 Direct 侧按自身配置决定是否注入。
//
// 当前行为（红）：handoff.request_payload 含 reasoningStop tool 与"当前轮推进准则"，
// 但 5555 direct stopless_center=false，Direct 响应侧不消费 → 模型调用 reasoningStop
// 后被直接透传（live 5555 no_live_stopless_path 根因）。
use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayLocalStoplessControlInput, V3ResponsesRelayProviderHealthHandle,
    V3ResponsesRelayRuntimeInput, V3ResponsesRelayStoplessControlState,
};
use serde_json::{json, Value};
use std::sync::Mutex;

struct UnusedTransport {
    captures: Mutex<Vec<Value>>,
}

#[async_trait]
impl ResponsesTransport for UnusedTransport {
    async fn send(
        &self,
        _request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        panic!("SameProtocolDirect handoff must not invoke the transport");
    }
}

#[tokio::test]
async fn relay_direct_handoff_strips_current_turn_stopless_contract() {
    let manifest = manifest();
    let transport = UnusedTransport {
        captures: Mutex::new(Vec::new()),
    };
    let continuation = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-relay-direct-handoff",
        "conv-relay-direct-handoff",
        5555,
        "responses_v3_5555",
    );

    let result =
        execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
            &manifest,
            V3ResponsesRelayRuntimeInput {
                server_id: "responses_v3_5555".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "responses_v3_5555",
                    "responses_v3_5555",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("provider failure scope"),
                request_id: "req-relay-direct-handoff-stopless".into(),
                payload: json!({
                    "model":"gpt-5.5",
                    "stream":false,
                    "tool_choice":"none",
                    "input":[
                        {"type":"message","role":"user","content":[{"type":"input_text","text":"继续目标"}]}
                    ]
                }),
            },
            &transport,
            &provider_health,
            V3ResponsesRelayLocalStoplessControlInput::new(
                &continuation,
                &stopless_control,
                scope,
                13_000,
            ),
        )
        .await;

    let output = result.expect("relay runtime must complete");
    let handoff = output
        .protocol_direct_handoff
        .expect("SameProtocolDirect target must hand off to Direct");
    let serialized = serde_json::to_string(&handoff.request_payload).unwrap();

    // GREEN expectation: relay's current-turn stopless contract must not leak
    // into the Direct handoff; Direct decides injection by its own config.
    assert!(
        !serialized.contains("reasoningStop"),
        "handoff payload must not carry relay-injected reasoningStop tool: {serialized}"
    );
    assert!(
        !serialized.contains("当前轮推进准则"),
        "handoff payload must not carry relay-injected guidance: {serialized}"
    );
    assert_eq!(
        handoff.request_payload.get("tool_choice"),
        Some(&Value::String("none".to_string())),
        "handoff payload must restore the original tool_choice=none: {serialized}"
    );
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[features]
stopless_center = true
responses_direct_stopless_center = false
[servers.responses_v3_5555]
bind = "127.0.0.1"
port = 5555
routing_group = "responses_v3_5555"
endpoints = ["responses"]
[servers.responses_v3_5555.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
[providers.cc_sol]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "gpt-5.6-sol"
auth = { type = "api_key", entries = [{ alias = "key1", env = "TEST_KEY" }] }
responses = { process = "direct", streaming = "always", transport = "http" }
[providers.cc_sol.models."gpt-5.6-sol"]
wire_name = "gpt-5.6-sol"
supports_streaming = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.responses_v3_5555.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "cc_sol", model = "gpt-5.6-sol", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
