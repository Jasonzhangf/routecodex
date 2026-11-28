//! Public regression: one recoverable failure leaves the exact identity
//! routable, while confirmed authentication failure excludes it immediately.
//! Command: CARGO_NET_OFFLINE=true cargo test --locked --manifest-path v3/Cargo.toml
//! -p routecodex-v3-server --test no_first_failure_cooldown_blackbox -- --nocapture
//! Run with an isolated test HOME, as server error sampling uses HOME/.rcc.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
use tokio::{
    sync::{oneshot, Mutex, Notify},
    time::{timeout, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

#[path = "support/fa22072_test_home.rs"]
mod test_home;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

#[derive(Default)]
struct Upstream {
    receipts: Mutex<BTreeMap<String, usize>>,
    fallback_receipts: Mutex<BTreeMap<String, usize>>,
    /// Attempts keyed by `<input>@<requested model>`. Reselection may reach a
    /// different identity for the same request, so per-identity counting keeps
    /// "never retried the failed identity" provable.
    identity_receipts: Mutex<BTreeMap<String, usize>>,
    held_forbidden_entered: Notify,
    held_forbidden_release: Notify,
}

/// The independent provider mirrors the primary upstream contract on its own
/// path, so its attempts are attributable without a shared receipt counter.
async fn independent_provider(
    State(state): State<Arc<Upstream>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let input = request_input_text(&body);
    if input.contains("ping; reply pong") {
        return controlled_failure(StatusCode::SERVICE_UNAVAILABLE, "probe_unavailable");
    }
    *state
        .receipts
        .lock()
        .await
        .entry(format!("independent:{input}"))
        .or_default() += 1;
    upstream_response(&input)
}

async fn provider(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    let input = request_input_text(&body);
    if input.contains("ping; reply pong") {
        return controlled_failure(StatusCode::SERVICE_UNAVAILABLE, "probe_unavailable");
    }
    // Startup/recovery probes are distinct from business receipts.
    if input.starts_with("health-test:") {
        let model = body["model"].as_str().unwrap_or("").to_string();
        *state
            .receipts
            .lock()
            .await
            .entry(input.to_string())
            .or_default() += 1;
        *state
            .identity_receipts
            .lock()
            .await
            .entry(format!("{input}@{model}"))
            .or_default() += 1;
    }
    if input == "health-test:forbidden-held" {
        state.held_forbidden_entered.notify_one();
        state.held_forbidden_release.notified().await;
    }
    upstream_response(&input)
}

fn request_input_text(body: &Value) -> String {
    if let Some(input) = body["input"].as_str() {
        return input.to_string();
    }
    body["input"]
        .as_array()
        .and_then(|items| {
            items.iter().find_map(|item| {
                let content = item.get("content")?;
                content.as_str().map(str::to_string).or_else(|| {
                    content.as_array().and_then(|parts| {
                        parts
                            .iter()
                            .find_map(|part| part["text"].as_str().map(str::to_string))
                    })
                })
            })
        })
        .unwrap_or_else(|| body["input"].to_string())
}

/// Shared upstream contract: auth/server/fail inputs are controlled failures,
/// everything else is a real successful business response.
fn upstream_response(input: &str) -> Response<Body> {
    if input.starts_with("health-test:forbidden-invalid") {
        return controlled_failure(StatusCode::FORBIDDEN, "invalid_request_error");
    }
    if input.starts_with("health-test:forbidden") {
        return controlled_failure(StatusCode::FORBIDDEN, "permission_error");
    }
    if input.starts_with("health-test:invalid") {
        return controlled_failure(StatusCode::BAD_REQUEST, "invalid_request_error");
    }
    if input.starts_with("health-test:fail")
        || input.starts_with("health-test:auth")
        || input.starts_with("health-test:server")
    {
        let (status, kind) = if input.starts_with("health-test:auth") {
            (StatusCode::UNAUTHORIZED, "invalid_api_key")
        } else if input.starts_with("health-test:server") {
            (StatusCode::INTERNAL_SERVER_ERROR, "server_error")
        } else {
            (StatusCode::TOO_MANY_REQUESTS, "rate_limit_error")
        };
        return controlled_failure(status, kind);
    }
    successful_response(&input)
}

fn successful_response(input: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"id":"resp_health","object":"response","status":"completed",
            "output":[{"type":"message","id":"msg_health","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":input,"annotations":[]}]}]})
            .to_string(),
        ))
        .unwrap()
}

fn controlled_failure(status: StatusCode, kind: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"error":{"type":kind,"code":kind,"message":"controlled real upstream failure"}})
                .to_string(),
        ))
        .unwrap()
}

fn manifest(
    upstream: &str,
    alias: &str,
    port: u16,
    relay: bool,
    include_fallback: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let mut declaration = hub_v1_fixture::hub_v1_test_declaration();
    if relay {
        let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
        let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
        assert!(declaration.contains(direct));
        declaration = declaration.replacen(direct, relay, 1);
    }
    let fallback_target = if include_fallback {
        r#",{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }"#
    } else {
        ""
    };
    let execution = hub_v1_fixture::hub_v1_server_execution("health");
    let source = format!(
        r#"
version = 3
{declaration}
[error]
provider_error_default_path = [
  {{ step = "wait_retry", retry_mode = "reselect_before_client_projection", max_attempts = 1, backoff_ms = 0 }},
  {{ step = "cooldown", scope = "provider_model", duration_ms = 5000, provider_global_failure = false }},
  {{ step = "project", reason_code = "provider_failure" }},
]
[servers.health]
bind = "127.0.0.1"
port = {port}
routing_group = "health"
endpoints = ["responses"]
{execution}
[providers.primary]
type = "responses"
base_url = "{upstream}/v1"
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "{alias}", env = "V3_NO_FIRST_FAILURE_TEST_KEY" }}, {{ alias = "sibling", env = "V3_NO_FIRST_FAILURE_TEST_KEY" }}] }}
[providers.primary.models.main]
wire_name = "main"
supports_streaming = true
[providers.primary.models.other]
wire_name = "other"
supports_streaming = true
[providers.independent]
type = "responses"
base_url = "{upstream}/independent/v1"
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "independent", env = "V3_NO_FIRST_FAILURE_TEST_KEY" }}] }}
[providers.independent.models.main]
wire_name = "main"
capabilities = ["vision"]
supports_streaming = true
[providers.fallback]
type = "responses"
base_url = "{upstream}/fallback/v1"
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "fallback", env = "V3_NO_FIRST_FAILURE_TEST_KEY" }}] }}
[providers.fallback.models.main]
capabilities = ["vision"]
supports_streaming = true
[debug]
log_console = false
snapshots = false
codex_samples = false
[route_groups.health.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "main", key = "{alias}", priority = 100 }}{fallback_target}
]
[route_groups.health.pools.other]
match = {{ entry_protocol = "responses", required_capabilities = ["web_search"], precedence = 10 }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "other", key = "{alias}", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
[route_groups.health.pools.sibling]
match = {{ entry_protocol = "responses", required_capabilities = ["tools"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "primary", model = "main", key = "sibling", priority = 100 }}]
[route_groups.health.pools.independent]
match = {{ entry_protocol = "responses", required_capabilities = ["multimodal"], precedence = 10 }}
targets = [
  {{ kind = "provider_model", provider = "independent", model = "main", key = "independent", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn request(client: &reqwest::Client, base: &str, model: &str, marker: &str) {
    timeout(Duration::from_secs(8), async {
        let response = client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&json!({"model":model,"input":marker,"stream":false}))
            .send()
            .await
            .expect("healthy candidate must answer");
        assert_eq!(response.status(), 200);
        let body = response.text().await.unwrap();
        assert!(
            body.contains(marker),
            "must return the real successful provider payload: {body}"
        );
        assert!(
            !body.contains("\"error\""),
            "client must not receive an error envelope: {body}"
        );
    })
    .await
    .expect("healthy fallback must complete headers and body within the unchanged bound");
}

async fn request_with_tool(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    marker: &str,
    tool_name: &str,
    tool_arguments: &str,
) {
    let input = json!([
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": marker}]
        },
        {
            "type": "function_call",
            "name": tool_name,
            "call_id": "call-health-continuation",
            "arguments": tool_arguments
        },
        {
            "type": "function_call_output",
            "call_id": "call-health-continuation",
            "output": "ok"
        }
    ]);
    timeout(Duration::from_secs(8), async {
        let response = client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&json!({
                "model": model,
                "input": input,
                "tools": [{
                    "type": "function",
                    "name": tool_name,
                    "parameters": {"type": "object"}
                }],
                "stream": false
            }))
            .send()
            .await
            .expect("healthy candidate must answer");
        assert_eq!(response.status(), 200);
        let body = response.text().await.unwrap();
        assert!(
            body.contains(marker),
            "must return the real successful provider payload: {body}"
        );
        assert!(
            !body.contains("\"error\""),
            "client must not receive an error envelope: {body}"
        );
    })
    .await
    .expect("healthy fallback must complete headers and body within the unchanged bound");
}

async fn request_with_input(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    marker: &str,
    input: Value,
    tools: Option<Value>,
) {
    timeout(Duration::from_secs(8), async {
        let mut body = json!({
            "model": model,
            "input": input,
            "stream": false
        });
        if let Some(tools) = tools {
            body["tools"] = tools;
        }
        let response = client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&body)
            .send()
            .await
            .expect("healthy candidate must answer");
        assert_eq!(response.status(), 200);
        let body = response.text().await.unwrap();
        assert!(
            body.contains(marker),
            "must return the real successful provider payload: {body}"
        );
        assert!(
            !body.contains("\"error\""),
            "client must not receive an error envelope: {body}"
        );
    })
    .await
    .expect("healthy fallback must complete headers and body within the unchanged bound");
}

async fn pool(client: &reqwest::Client, base: &str) -> Vec<Value> {
    let response = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.unwrap()["entries"]
        .as_array()
        .unwrap()
        .clone()
}

async fn receipt(state: &Upstream, marker: &str) {
    assert_eq!(
        state.receipts.lock().await.get(marker),
        Some(&1),
        "{marker}: must reach upstream exactly once; no retry may hide a failure"
    );
}

async fn fallback_receipt(state: &Upstream, marker: &str) {
    assert_eq!(
        state.fallback_receipts.lock().await.get(marker),
        Some(&1),
        "{marker}: healthy fallback must receive exactly one actual attempt"
    );
}

fn assert_identities(entries: Vec<Value>, expected: &[(&str, &str, &str, &str)]) {
    let mut actual: Vec<_> = entries
        .iter()
        .map(|e| {
            (
                e["provider_id"].as_str().unwrap(),
                e["interface_id"].as_str().unwrap(),
                e["auth_alias"].as_str().unwrap(),
                e["model_id"].as_str().unwrap(),
            )
        })
        .collect();
    actual.sort();
    let mut expected = expected.to_vec();
    expected.sort();
    assert_eq!(
        actual, expected,
        "cooldown must contain only the exact failed identities"
    );
}

async fn fallback(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    let input = request_input_text(&body);
    *state
        .fallback_receipts
        .lock()
        .await
        .entry(input.to_string())
        .or_default() += 1;
    successful_response(&input)
}

/// Asserts an exact requested model reached upstream exactly once.
async fn receipt_at(state: &Upstream, input: &str, model: &str) {
    let key = format!("{input}@{model}");
    assert_eq!(
        state.identity_receipts.lock().await.get(&key),
        Some(&1),
        "{key}: must reach upstream exactly once for that identity"
    );
}

async fn start_upstream() -> (
    String,
    String,
    Arc<Upstream>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("public blackbox requires loopback sockets");
    let upstream_addr = listener.local_addr().unwrap();
    let state = Arc::new(Upstream::default());
    let (shutdown, stopped) = oneshot::channel::<()>();
    let app = Router::new()
        .route("/v1/responses", post(provider))
        .route("/fallback/v1/responses", post(fallback))
        .route("/independent/v1/responses", post(independent_provider))
        .with_state(state.clone());
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let alias = format!("key-{}", upstream_addr.port());
    (
        format!("http://{upstream_addr}"),
        alias,
        state,
        shutdown,
        upstream,
    )
}

fn listener_port() -> u16 {
    let server_locator = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    server_locator.local_addr().unwrap().port()
}

#[tokio::test]
async fn no_first_failure_cooldown_public_http() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var("V3_NO_FIRST_FAILURE_TEST_KEY", "controlled-test-key");
    let (upstream_url, alias, state, shutdown, upstream) = start_upstream().await;
    let port = listener_port();
    let mut active_manifest = manifest(&upstream_url, &alias, port, false, true);
    // Keep the test listener's declared persistence identity stable while
    // asking the OS for a fresh socket on each start.
    active_manifest.servers.get_mut("health").unwrap().port = 0;
    let handle = spawn_v3_server_aggregate(active_manifest.clone())
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    for phase in 0..3 {
        let attempts = if phase == 2 { 3 } else { 4 };
        for attempt in 1..=attempts {
            let marker = format!("health-test:forbidden-{phase}-{attempt}");
            request(&client, &base, "main", &marker).await;
            receipt(&state, &marker).await;
            fallback_receipt(&state, &marker).await;
            assert_identities(pool(&client, &base).await, &[]);
        }
        match phase {
            0 => request(&client, &base, "main", "health-test:server-break").await,
            1 => {
                let concurrent_client = client.clone();
                let concurrent_base = base.clone();
                let held = tokio::spawn(async move {
                    request(
                        &concurrent_client,
                        &concurrent_base,
                        "main",
                        "health-test:forbidden-held",
                    )
                    .await;
                });
                timeout(
                    Duration::from_secs(8),
                    state.held_forbidden_entered.notified(),
                )
                .await
                .unwrap();
                request(&client, &base, "main", "health-test:success-break").await;
                state.held_forbidden_release.notify_one();
                held.await.unwrap();
                receipt(&state, "health-test:forbidden-held").await;
                fallback_receipt(&state, "health-test:forbidden-held").await;
                assert_identities(pool(&client, &base).await, &[]);
            }
            _ => {}
        }
    }
    handle.shutdown().await;
    let mut terminal_manifest = manifest(&upstream_url, &alias, port, false, false);
    terminal_manifest.servers.get_mut("health").unwrap().port = 0;
    let handle = spawn_v3_server_aggregate(terminal_manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let terminal = "health-test:forbidden-terminal";
    let response = client
        .post(format!("{base}/v1/responses"))
        .json(&json!({"model":"main","input":terminal,"stream":false}))
        .send()
        .await;
    response.expect_err(
        "exhausted final provider 403 must terminate transport without HTTP error projection",
    );
    receipt(&state, terminal).await;
    assert_identities(pool(&client, &base).await, &[]);
    handle.shutdown().await;
    let handle = spawn_v3_server_aggregate(active_manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let marker = "health-test:forbidden-2-10";
    request(&client, &base, "main", marker).await;
    receipt(&state, marker).await;
    fallback_receipt(&state, marker).await;
    assert_identities(
        pool(&client, &base).await,
        &[("primary", "default", &alias, "main")],
    );
    let marker = "health-test:after-forbidden-cooldown";
    request(&client, &base, "main", marker).await;
    fallback_receipt(&state, marker).await;
    assert!(!state.receipts.lock().await.contains_key(marker));
    let response = client
        .post(format!("{base}/_routecodex/health/cooldown-pool"))
        .json(&json!({"provider_id":"primary","interface_id":"default","auth_alias":alias,"model_id":"main","kind":"probe"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.json::<Value>().await.unwrap()["removed"], true);

    request(&client, &base, "main", "health-test:fail-isolated").await;
    receipt(&state, "health-test:fail-isolated").await;
    fallback_receipt(&state, "health-test:fail-isolated").await;
    assert_identities(pool(&client, &base).await, &[]);
    request(&client, &base, "main", "health-test:fresh-after-429").await;
    receipt(&state, "health-test:fresh-after-429").await;
    assert!(
        !state
            .fallback_receipts
            .lock()
            .await
            .contains_key("health-test:fresh-after-429"),
        "the first 429 must not hide the healthy response from a new session"
    );
    receipt(&state, "health-test:fail-isolated").await;
    assert_identities(pool(&client, &base).await, &[]);
    request_with_input(
        &client,
        &base,
        "other",
        "health-test:other-model",
        json!([{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "health-test:other-model"},
                {"type": "input_text", "text": "search the web"}
            ]
        }]),
        Some(json!([{"type": "web_search"}])),
    )
    .await;
    request_with_tool(
        &client,
        &base,
        "sibling",
        "health-test:other-key",
        "controlled_tool",
        "{}",
    )
    .await;
    request_with_input(
        &client,
        &base,
        "independent",
        "health-test:independent",
        json!([{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "health-test:independent"},
                {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="}
            ]
        }]),
        None,
    )
    .await;
    receipt(&state, "health-test:other-model").await;
    receipt(&state, "health-test:other-key").await;
    assert_eq!(
        state
            .receipts
            .lock()
            .await
            .get("independent:health-test:independent"),
        Some(&1)
    );
    assert_identities(pool(&client, &base).await, &[]);

    request_with_input(
        &client,
        &base,
        "other",
        "health-test:server-terminal",
        json!([{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "health-test:server-terminal"},
                {"type": "input_text", "text": "search the web"}
            ]
        }]),
        Some(json!([{"type": "web_search"}])),
    )
    .await;
    receipt_at(&state, "health-test:server-terminal", "other").await;
    fallback_receipt(&state, "health-test:server-terminal").await;
    assert_identities(pool(&client, &base).await, &[]);
    request_with_tool(
        &client,
        &base,
        "sibling",
        "health-test:after-server-failure",
        "controlled_tool",
        "{}",
    )
    .await;
    receipt(&state, "health-test:after-server-failure").await;
    assert_identities(pool(&client, &base).await, &[]);

    for attempt in 1..=5 {
        let marker = format!("health-test:auth-terminal-{attempt}");
        request_with_input(
            &client,
            &base,
            "independent",
            &marker,
            json!([{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": marker},
                    {"type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo="}
                ]
            }]),
            None,
        )
        .await;
        assert_eq!(
            state
                .receipts
                .lock()
                .await
                .get(&format!("independent:health-test:auth-terminal-{attempt}")),
            Some(&1)
        );
        fallback_receipt(&state, &format!("health-test:auth-terminal-{attempt}")).await;
        let expected = [("independent", "default", "independent", "main")];
        assert_identities(
            pool(&client, &base).await,
            if attempt == 5 { &expected } else { &[] },
        );
    }

    handle.shutdown().await;
    shutdown.send(()).unwrap();
    upstream.await.unwrap();
    std::env::remove_var("V3_NO_FIRST_FAILURE_TEST_KEY");
}

#[tokio::test]
async fn relay_http_400_breaks_forbidden_streak_without_cooling() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var("V3_NO_FIRST_FAILURE_TEST_KEY", "controlled-test-key");
    let (upstream_url, alias, state, shutdown, upstream) = start_upstream().await;
    let handle =
        spawn_v3_server_aggregate(manifest(&upstream_url, &alias, listener_port(), true, true))
            .await
            .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for attempt in 1..=4 {
        let marker = format!("health-test:forbidden-before-invalid-{attempt}");
        request(&client, &base, "main", &marker).await;
        receipt(&state, &marker).await;
    }
    for marker in [
        "health-test:invalid-break",
        "health-test:forbidden-after-invalid",
    ] {
        request(&client, &base, "main", marker).await;
        receipt(&state, marker).await;
        fallback_receipt(&state, marker).await;
        assert_identities(pool(&client, &base).await, &[]);
    }
    request(&client, &base, "main", "health-test:success-after-invalid").await;
    for attempt in 1..=5 {
        let marker = format!("health-test:forbidden-invalid-{attempt}");
        request(&client, &base, "main", &marker).await;
        receipt(&state, &marker).await;
        fallback_receipt(&state, &marker).await;
        let expected = [("primary", "default", alias.as_str(), "main")];
        assert_identities(
            pool(&client, &base).await,
            if attempt == 5 { &expected } else { &[] },
        );
    }
    handle.shutdown().await;
    shutdown.send(()).unwrap();
    upstream.await.unwrap();
    std::env::remove_var("V3_NO_FIRST_FAILURE_TEST_KEY");
}
