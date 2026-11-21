use super::*;
use crate::endpoint_handlers::execute_v3_responses_relay_provider_request_dry_run;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

#[allow(dead_code)]
#[path = "../../../routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

#[tokio::test]
async fn issue1f60200_relay_dry_run_handoff_preserves_client_identity() {
    let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = upstream.local_addr().unwrap();
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let port = addr.port();
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let test_home = std::env::temp_dir().join(format!(
        "routecodex-issue1f60200-handoff-{}-{port}",
        std::process::id()
    ));
    std::fs::create_dir(&test_home).unwrap();
    let home = TestHomeGuard::set(&test_home);
    let key_env = "V3_ISSUE_1F60200_HANDOFF_KEY";
    std::env::set_var(key_env, "fixture-provider-key");
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&format!(
            r#"
version = 3
{declaration}
[servers.handoff]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]

[servers.handoff.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.controlled]
type = "responses"
base_url = "http://{addr}/v1"
default_model = "fixture-wire"
auth = {{ type = "api_key", entries = [{{ alias = "fixture", env = "{key_env}" }}] }}

[providers.controlled.models.fixture-wire]
wire_name = "fixture-wire"
capabilities = ["text"]
supports_streaming = true

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "fixture-wire", key = "fixture", priority = 1 }}]
"#
        ))
        .unwrap(),
    )
    .unwrap();
    let debug = V3DebugRuntime::new(V3DebugRuntimeConfig {
        snapshots_enabled: true,
        dry_run_enabled: true,
        ..Default::default()
    })
    .unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("user-agent", "fixture-client/1.0".parse().unwrap());
    headers.insert("originator", "fixture-client".parse().unwrap());
    let result = execute_v3_responses_relay_provider_request_dry_run(
        &manifest,
        &debug,
        V3DryRunFixture {
            fixture_id: "identity-handoff".to_string(),
            server_id: "handoff".to_string(),
            method: "POST".to_string(),
            path: "/v1/responses".to_string(),
            request_payload: json!({"model": "fixture-wire", "input": "identity preview"}),
            response_payload: json!({
                "object": "response",
                "status": "completed",
                "output": [{"type":"output_text","text":"identity preview"}]
            }),
        },
        V3ProviderFailureSessionScope::new("handoff", "default", "identity-handoff").unwrap(),
        &headers,
    )
    .await;
    std::env::remove_var(key_env);
    drop(home);
    std::fs::remove_dir_all(test_home).unwrap();
    assert_eq!(result.status, 200, "{:?}", result.diagnostic_source);
    assert!(result.node_trace.contains(&"V3HubReqChatProcess04Governed"));
    assert!(result.node_trace.contains(&"V3ResponsesDirect11Policy"));
    assert_eq!(result.body["evidence"]["providerNetworkSend"], false);
    assert_eq!(
        result.body["providerRequest"]["headers"]["user-agent"],
        "[REDACTED]"
    );
    assert_eq!(
        result.body["providerRequest"]["headers"]["originator"],
        "[REDACTED]"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), upstream.accept())
            .await
            .is_err()
    );
}
