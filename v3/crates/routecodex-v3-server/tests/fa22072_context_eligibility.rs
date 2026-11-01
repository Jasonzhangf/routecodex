use axum::{body::Bytes, http::StatusCode, routing::post, Router};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::time::{timeout, Duration};
use tokio::{net::TcpListener, sync::oneshot};

const PIPELINE: &str = r#"
[pipelines.hub_v1]
skeleton = "hub_v1"
entry_protocols = ["responses", "anthropic", "gemini", "openai_chat"]
hook_set_id = "hub_v1.default"
entry_protocol_bindings = [
  { entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" },
  { entry_protocol = "anthropic", endpoint_patterns = ["/v1/messages"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Anthropic Messages endpoint must not fall through to pending runtime.", runtime_owner_symbol = "execute_v3_anthropic_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs" },
  { entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" },
  { entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "relay", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending runtime.", runtime_owner_symbol = "execute_v3_gemini_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs" }
]
resources = { metadata_center = { kind = "control", scope = "request" }, error_chain = { kind = "error", scope = "request" }, debug_artifact = { kind = "debug", scope = "debug" }, snapshot_buffer = { kind = "snapshot", scope = "debug" }, provider_health = { kind = "provider_health", scope = "provider" } }
hooks = [
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.entry.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "entry", requirement = "required", priority = 0, order = 0, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.exit.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "exit", requirement = "required", priority = 0, order = 1, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.entry.not_implemented", node = "V3HubReqInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 2, allowed_resources = ["metadata_center"], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.exit.not_implemented", node = "V3HubReqInbound02Normalized", phase = "exit", requirement = "optional", enabled = false, priority = 0, order = 3, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.entry.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "entry", requirement = "required", priority = 0, order = 4, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.exit.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "exit", requirement = "required", priority = 0, order = 5, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.entry.not_implemented", node = "V3HubReqExecution05Planned", phase = "entry", requirement = "required", priority = 0, order = 6, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.exit.not_implemented", node = "V3HubReqExecution05Planned", phase = "exit", requirement = "required", priority = 0, order = 7, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.entry.not_implemented", node = "V3HubReqTarget06Resolved", phase = "entry", requirement = "required", priority = 0, order = 8, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.exit.not_implemented", node = "V3HubReqTarget06Resolved", phase = "exit", requirement = "required", priority = 0, order = 9, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.entry.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "entry", requirement = "required", priority = 0, order = 10, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.exit.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "exit", requirement = "required", priority = 0, order = 11, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderReqCompat06ProviderCompat.entry.not_implemented", node = "ProviderReqCompat06ProviderCompat", phase = "entry", requirement = "required", priority = 0, order = 12, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderReqCompat06ProviderCompat.exit.not_implemented", node = "ProviderReqCompat06ProviderCompat", phase = "exit", requirement = "required", priority = 0, order = 13, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.entry.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "entry", requirement = "required", priority = 0, order = 14, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.exit.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "exit", requirement = "required", priority = 0, order = 15, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.entry.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "entry", requirement = "required", priority = 0, order = 16, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.exit.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "exit", requirement = "required", priority = 0, order = 17, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.entry.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "entry", requirement = "required", priority = 0, order = 18, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.exit.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "exit", requirement = "required", priority = 0, order = 19, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderRespCompat02ProviderCompat.entry.not_implemented", node = "ProviderRespCompat02ProviderCompat", phase = "entry", requirement = "required", priority = 0, order = 20, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderRespCompat02ProviderCompat.exit.not_implemented", node = "ProviderRespCompat02ProviderCompat", phase = "exit", requirement = "required", priority = 0, order = 21, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.entry.not_implemented", node = "V3HubRespInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 22, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.exit.not_implemented", node = "V3HubRespInbound02Normalized", phase = "exit", requirement = "required", priority = 0, order = 23, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.entry.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "entry", requirement = "required", priority = 0, order = 24, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.exit.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "exit", requirement = "required", priority = 0, order = 25, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.entry.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "entry", requirement = "required", priority = 0, order = 26, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.exit.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "exit", requirement = "required", priority = 0, order = 27, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.entry.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "entry", requirement = "required", priority = 0, order = 28, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "exit", requirement = "required", priority = 0, order = 29, allowed_resources = [], forbidden_resources = [] }
]
"#;

struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-v3-server-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(&self.path);
        assert!(!self.path.exists(), "owned fixture home must be absent");
        eprintln!(
            "fixture-home-cleanup absent=true path={}",
            self.path.display()
        );
    }
}

fn eligible_manifest(provider_base_url: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    // This case counts upstream attempts, so the Chat Process continuation
    // must not add an extra execution.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
    let source = format!(
        r#"
version = 3
{PIPELINE}
[servers.a]
bind = "127.0.0.1"
port = 18081
routing_group = "default"
endpoints = ["responses"]
[servers.a.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client"]
allowed_transports = ["json"]
[servers.b]
bind = "127.0.0.1"
port = 18082
routing_group = "default"
endpoints = ["responses"]
[servers.b.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client"]
allowed_transports = ["json"]
[providers.test]
type = "responses"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "normal", env = "FA22072_CONTEXT_NORMAL_KEY" }}, {{ alias = "pinned", env = "FA22072_CONTEXT_PINNED_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.test.models.test]
wire_name = "wire-test"
capabilities = ["text"]
supports_streaming = false
max_tokens = 4096
max_context_tokens = 1000
context_token_estimate_scale_bps = 20000
[providers.test.models.client]
wire_name = "wire-client"
aliases = ["client-test"]
capabilities = ["text"]
supports_streaming = false
max_tokens = 4096
max_context_tokens = 1000
context_token_estimate_scale_bps = 20000
[debug]
log_console = false
snapshots = false
dry_run = false
codex_samples = false
retention = {{ raw_requests = 4, raw_responses = 4, events = 16 }}
[route_groups.default.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-test"] }}
targets = [{{ kind = "provider_model", provider = "test", model = "client", key = "normal", priority = 1 }}]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "normal", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

#[tokio::test]
async fn context_estimate_exceeded_reaches_provider_for_route_and_pin() {
    let _home_guard = TestHomeGuard::new("fa22072-context-eligibility");
    std::env::set_var("FA22072_CONTEXT_NORMAL_KEY", "secret-route");
    std::env::set_var("FA22072_CONTEXT_PINNED_KEY", "secret-pin");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_provider = Arc::clone(&captured);
    let app = Router::new().route(
        "/v1/responses",
        post(move |raw: Bytes| {
            let captured_provider = Arc::clone(&captured_provider);
            async move {
                eprintln!("provider-raw={}", String::from_utf8_lossy(&raw));
                let body: Value = serde_json::from_slice(&raw).unwrap();
                captured_provider.lock().unwrap().push(body);
                let response = axum::Json(json!({
                    "id": "resp_context_eligible",
                    "object": "response",
                    "status": "completed",
                    "output_text": "ok",
                    "output": [{
                        "type": "message",
                        "id": "msg_context_eligible",
                        "role": "assistant",
                        "status": "completed",
                        "content": [{
                            "type": "output_text",
                            "text": "ok",
                            "annotations": []
                        }]
                    }]
                }));
                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    response,
                )
            }
        }),
    );
    let (shutdown, stopped) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap()
    });
    let (reserved_a, reserved_b) = (
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
    );
    let (port_a, port_b) = (
        reserved_a.local_addr().unwrap().port(),
        reserved_b.local_addr().unwrap().port(),
    );
    let mut manifest = eligible_manifest(&format!("http://{address}/v1"));
    manifest.servers.get_mut("a").unwrap().port = port_a;
    manifest.servers.get_mut("b").unwrap().port = port_b;
    drop((reserved_a, reserved_b));
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let original_diagnostic: Value = client
        .post(format!("http://{}/_routecodex/diagnostics/virtual-router/dry-run", handle.listeners[0].addr))
        .json(&json!({"request": {"model": "client-test", "input": "context eligible marker ".repeat(100), "stream": false}, "endpoint": "/v1/responses"}))
        .timeout(Duration::from_secs(5))
        .send().await.unwrap().json().await.unwrap();
    eprintln!("original-r6-router-diagnostic={original_diagnostic}");
    // 200 repetitions cross the scaled window; 100 do not. These are
    // ordinary Responses text inputs, with no injected routing facts.
    let input = "context eligible marker ".repeat(200);
    let mut outcomes = Vec::new();
    for request_model in ["client-test", "test.test"] {
        let request = json!({"model": request_model, "input": input, "stream": false});
        eprintln!("client-request={request}");
        let diagnostic: Value = client
            .post(format!(
                "http://{}/_routecodex/diagnostics/virtual-router/dry-run",
                handle.listeners[0].addr
            ))
            .json(&json!({"request": request, "endpoint": "/v1/responses"}))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        eprintln!("router-diagnostic model={request_model} {diagnostic}");
        let response = timeout(
            Duration::from_secs(5),
            client.post(&endpoint).json(&request).send(),
        )
        .await;
        let outcome = match response {
            Ok(Ok(response)) => {
                let status = response.status();
                match timeout(Duration::from_secs(5), response.json::<Value>()).await {
                    Ok(Ok(body)) => Ok((status, body)),
                    other => Err(format!("response body failure: {other:?}")),
                }
            }
            other => Err(format!(
                "request failed or exceeded fixture deadline: {other:?}"
            )),
        };
        eprintln!(
            "public-outcome model={request_model} {outcome:?} captures={}",
            captured.lock().unwrap().len()
        );
        outcomes.push((request_model, diagnostic, outcome));
    }
    handle.shutdown().await;
    let _ = shutdown.send(());
    server.await.unwrap();
    eprintln!("fixture-listeners-stopped=true");
    for (request_model, diagnostic, outcome) in outcomes {
        let tokens = diagnostic["diagnostics"]["diagnosticInput"]["requestInputTokens"]
            .as_u64()
            .unwrap();
        assert!(
            tokens <= 1000 && tokens * 2 > 1000,
            "fixture must exceed only the scaled context window: {tokens}"
        );
        let (status, body) = outcome.unwrap_or_else(|error| {
            panic!("{request_model}: healthy provider must receive the request: {error}")
        });
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "completed");
        assert_eq!(
            body["output"],
            json!([{
                "type": "message",
                "id": "msg_context_eligible",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "ok", "annotations": []}]
            }])
        );
    }
    let captures = captured.lock().unwrap().clone();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[0]["model"], json!("wire-client"));
    assert_eq!(captures[1]["model"], json!("wire-test"));
    assert!(captures.iter().all(|body| body["input"] == json!(input)));
}
