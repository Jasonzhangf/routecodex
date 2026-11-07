//! Public regression: provider failures, including HTTP 429, immediately
//! exclude only the attempted identity. Healthy fallback, sibling models, keys
//! and providers stay usable while independent probe lifecycles control only
//! the exact failed identities' visibility.
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
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

#[derive(Default)]
struct Upstream {
    receipts: Mutex<BTreeMap<String, usize>>,
    fallback_receipts: Mutex<BTreeMap<String, usize>>,
    /// Attempts keyed by `<input>@<requested model>`. Reselection may reach a
    /// different identity for the same request, so per-identity counting keeps
    /// "never retried the failed identity" provable.
    identity_receipts: Mutex<BTreeMap<String, usize>>,
}

fn input_marker(body: &Value) -> String {
    fn find_marker(value: &Value) -> Option<&str> {
        match value {
            Value::String(text) if text.starts_with("route-case:") => Some(text),
            Value::Array(items) => items.iter().find_map(find_marker),
            Value::Object(fields) => fields.values().find_map(find_marker),
            _ => None,
        }
    }

    find_marker(&body["input"]).unwrap_or_default().to_string()
}

/// The independent provider mirrors the primary upstream contract on its own
/// path, so its attempts are attributable without a shared receipt counter.
async fn independent_provider(
    State(state): State<Arc<Upstream>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    if body["input"].to_string().contains("ping; reply pong") {
        return controlled_failure(StatusCode::SERVICE_UNAVAILABLE, "probe_unavailable");
    }
    let input = input_marker(&body);
    *state
        .receipts
        .lock()
        .await
        .entry(format!("independent:{input}"))
        .or_default() += 1;
    upstream_response(&input)
}

async fn provider(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    let input = input_marker(&body);
    if body["input"].to_string().contains("ping; reply pong") {
        return controlled_failure(StatusCode::SERVICE_UNAVAILABLE, "probe_unavailable");
    }
    // Startup/recovery probes are distinct from business receipts.
    if input.starts_with("route-case:") {
        let model = body["model"].as_str().unwrap_or("").to_string();
        *state
            .receipts
            .lock()
            .await
            .entry(input.clone())
            .or_default() += 1;
        *state
            .identity_receipts
            .lock()
            .await
            .entry(format!("{input}@{model}"))
            .or_default() += 1;
    }
    upstream_response(&input)
}

/// Shared upstream contract: auth/server/fail inputs are controlled failures,
/// everything else is a real successful business response.
fn upstream_response(input: &str) -> Response<Body> {
    if input.starts_with("route-case:fail")
        || input.starts_with("route-case:auth")
        || input.starts_with("route-case:server")
    {
        let (status, kind) = if input.starts_with("route-case:auth") {
            (StatusCode::UNAUTHORIZED, "invalid_api_key")
        } else if input.starts_with("route-case:server") {
            (StatusCode::INTERNAL_SERVER_ERROR, "server_error")
        } else {
            (StatusCode::TOO_MANY_REQUESTS, "rate_limit_error")
        };
        return controlled_failure(status, kind);
    }
    successful_response(input)
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
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
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
supports_streaming = true
[providers.fallback]
type = "responses"
base_url = "{upstream}/fallback/v1"
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "fallback", env = "V3_NO_FIRST_FAILURE_TEST_KEY" }}] }}
[providers.fallback.models.main]
supports_streaming = true
[debug]
log_console = false
snapshots = false
codex_samples = false
[route_groups.health.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "main", key = "{alias}", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
[route_groups.health.pools.tools]
match = {{ precedence = 10, required_capabilities = ["tools"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "main", key = "sibling", priority = 100 }}
]
[route_groups.health.pools.thinking]
match = {{ precedence = 10, required_capabilities = ["thinking"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "main", key = "{alias}", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
[route_groups.health.pools.coding]
match = {{ precedence = 10, required_capabilities = ["coding"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "other", key = "{alias}", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
[route_groups.health.pools.search]
match = {{ precedence = 10, required_capabilities = ["search"] }}
targets = [
  {{ kind = "provider_model", provider = "independent", model = "main", key = "independent", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn request_with_current_turn_call(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    marker: &str,
    tool_name: &str,
    arguments: Value,
) {
    timeout(Duration::from_secs(8), async {
        let mut body = json!({"model":model,"input":marker,"stream":false});
        body["tools"] = json!([{"type":"function","name":"lookup","parameters":{"type":"object"}}]);
        body["input"] = json!([
            {"role":"user","content":[{"type":"input_text","text":marker}]},
            {
                "type":"function_call",
                "name":tool_name,
                "call_id":"call_route_signal",
                "arguments":arguments
            },
            {
                "type":"function_call_output",
                "call_id":"call_route_signal",
                "output":"ok"
            }
        ]);
        let response = client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&body)
            .send()
            .await
            .expect("healthy candidate must answer");
        assert_eq!(response.status(), 200, "request marker={marker}");
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

async fn request_with_current_turn_tool(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    marker: &str,
    command: &str,
) {
    request_with_current_turn_call(
        client,
        base,
        model,
        marker,
        "exec_command",
        json!({"cmd":command}),
    )
    .await;
}

async fn request(client: &reqwest::Client, base: &str, model: &str, marker: &str) {
    timeout(Duration::from_secs(8), async {
        let body = json!({"model":model,"input":marker,"stream":false});
        let response = client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&body)
            .send()
            .await
            .expect("healthy candidate must answer");
        assert_eq!(response.status(), 200, "request marker={marker}");
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

async fn wait_for_cooldown_count(
    client: &reqwest::Client,
    base: &str,
    expected: usize,
) -> Vec<Value> {
    let mut last = Vec::new();
    let outcome = timeout(Duration::from_secs(4), async {
        loop {
            let entries = pool(client, base).await;
            if entries.len() == expected {
                return entries;
            }
            last = entries;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    outcome.unwrap_or_else(|error| {
        panic!("expected {expected} exact cooldowns: {error}; last={last:?}")
    })
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
    let input = input_marker(&body);
    *state
        .fallback_receipts
        .lock()
        .await
        .entry(input.clone())
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

async fn identity_count(state: &Upstream, input: &str, model: &str) -> usize {
    let key = format!("{input}@{model}");
    state
        .identity_receipts
        .lock()
        .await
        .get(&key)
        .copied()
        .unwrap_or_default()
}

#[tokio::test]
async fn no_first_failure_cooldown_public_http() {
    std::env::set_var("V3_NO_FIRST_FAILURE_TEST_KEY", "controlled-test-key");
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
    let server_locator = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = server_locator.local_addr().unwrap().port();
    drop(server_locator);
    let handle =
        spawn_v3_server_aggregate(manifest(&format!("http://{upstream_addr}"), &alias, port))
            .await
            .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    let began = tokio::time::Instant::now();
    request(&client, &base, "main", "route-case:fail-isolated").await;
    receipt(&state, "route-case:fail-isolated").await;
    fallback_receipt(&state, "route-case:fail-isolated").await;
    assert_identities(pool(&client, &base).await, &[]);
    request(&client, &base, "main", "route-case:fresh-after-429").await;
    assert!(
        !state
            .receipts
            .lock()
            .await
            .contains_key("route-case:fresh-after-429"),
        "fresh session must skip gated primary"
    );
    fallback_receipt(&state, "route-case:fresh-after-429").await;
    receipt(&state, "route-case:fail-isolated").await;
    assert!(
        began.elapsed() < Duration::from_millis(900),
        "fresh proof must precede the earliest 1s backoff expiry"
    );
    assert_identities(pool(&client, &base).await, &[]);
    request_with_current_turn_call(
        &client,
        &base,
        "main",
        "route-case:other-model",
        "apply_patch",
        json!({"input":"*** Begin Patch\n*** End Patch"}),
    )
    .await;
    request_with_current_turn_tool(&client, &base, "main", "route-case:sibling-key", "cargo test")
        .await;
    request_with_current_turn_tool(&client, &base, "main", "route-case:independent", "rg -n route src")
        .await;
    assert_eq!(
        identity_count(&state, "route-case:other-model", "other").await,
        1
    );
    receipt(&state, "route-case:sibling-key").await;
    assert_eq!(
        state
            .receipts
            .lock()
            .await
            .get("independent:route-case:independent"),
        Some(&1)
    );
    assert_identities(pool(&client, &base).await, &[]);

    request_with_current_turn_call(
        &client,
        &base,
        "main",
        "route-case:server-terminal",
        "apply_patch",
        json!({"input":"*** Begin Patch\n*** End Patch"}),
    )
    .await;
    receipt_at(&state, "route-case:server-terminal", "other").await;
    fallback_receipt(&state, "route-case:server-terminal").await;
    assert_identities(pool(&client, &base).await, &[]);
    assert_identities(
        wait_for_cooldown_count(&client, &base, 2).await,
        &[
            ("primary", "default", &alias, "main"),
            ("primary", "default", &alias, "other"),
        ],
    );
    request_with_current_turn_tool(
        &client,
        &base,
        "main",
        "route-case:after-server-failure",
        "cargo test",
    )
    .await;
    receipt(&state, "route-case:after-server-failure").await;
    assert_identities(
        pool(&client, &base).await,
        &[
            ("primary", "default", &alias, "main"),
            ("primary", "default", &alias, "other"),
        ],
    );

    request_with_current_turn_tool(
        &client,
        &base,
        "main",
        "route-case:auth-terminal",
        "rg -n route src",
    )
    .await;
    assert_eq!(
        state
            .receipts
            .lock()
            .await
            .get("independent:route-case:auth-terminal"),
        Some(&1)
    );
    fallback_receipt(&state, "route-case:auth-terminal").await;
    assert_identities(
        pool(&client, &base).await,
        &[
            ("primary", "default", &alias, "main"),
            ("primary", "default", &alias, "other"),
        ],
    );
    assert_identities(
        wait_for_cooldown_count(&client, &base, 3).await,
        &[
            ("primary", "default", &alias, "main"),
            ("primary", "default", &alias, "other"),
            ("independent", "default", "independent", "main"),
        ],
    );

    handle.shutdown().await;
    shutdown.send(()).unwrap();
    upstream.await.unwrap();
    std::env::remove_var("V3_NO_FIRST_FAILURE_TEST_KEY");
}
