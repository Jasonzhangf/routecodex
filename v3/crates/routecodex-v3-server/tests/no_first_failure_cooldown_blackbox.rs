//! Public regression: a single ordinary HTTP 429 latches a bounded hold on the
//! exact provider.model.key identity. The held key is excluded from later
//! selection (never retried), sibling models/keys stay eligible, and a real
//! success on the exact identity later releases it. HTTP 500 and 401 retain
//! their immediate isolation thresholds on their own identities.
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
    /// Attempts keyed by `<input>@<requested model>`. Reselection may reach a
    /// different identity for the same request, so per-identity counting keeps
    /// "never retried the failed identity" provable.
    identity_receipts: Mutex<BTreeMap<String, usize>>,
}

/// The fallback candidate always fails. Counting its attempts proves the
/// runtime reselected another provider instead of retrying the failed identity.
/// The independent provider mirrors the primary upstream contract on its own
/// path, so its attempts are attributable without a shared receipt counter.
async fn independent_provider(
    State(state): State<Arc<Upstream>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let input = body["input"].as_str().unwrap_or("");
    *state
        .receipts
        .lock()
        .await
        .entry(format!("independent:{input}"))
        .or_default() += 1;
    upstream_response(input)
}

async fn fallback_provider(State(state): State<Arc<Upstream>>) -> Response<Body> {
    *state
        .receipts
        .lock()
        .await
        .entry("__fallback_attempts".to_string())
        .or_default() += 1;
    controlled_failure(StatusCode::SERVICE_UNAVAILABLE, "server_error")
}

async fn provider(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    let input = body["input"].as_str().unwrap_or("");
    if body["input"].to_string().contains("ping; reply pong") {
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
    upstream_response(input)
}

/// Shared upstream contract: auth/server/fail inputs are controlled failures,
/// everything else is a real successful business response.
fn upstream_response(input: &str) -> Response<Body> {
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
[route_groups.health.pools.other]
match = {{ models = ["other"], precedence = 10 }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "other", key = "{alias}", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
[route_groups.health.pools.sibling]
match = {{ models = ["sibling"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "primary", model = "main", key = "sibling", priority = 100 }}]
[route_groups.health.pools.independent]
match = {{ models = ["independent"], precedence = 10 }}
targets = [
  {{ kind = "provider_model", provider = "independent", model = "main", key = "independent", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "main", key = "fallback", priority = 1 }}
]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn request(client: &reqwest::Client, base: &str, model: &str, marker: &str, success: bool) {
    let response = timeout(
        Duration::from_secs(8),
        client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&json!({"model":model,"input":marker,"stream":false}))
            .send(),
    )
    .await
    .expect("multi-candidate recovery must finish within the declared action-gate delay bound");
    if success {
        let response = response.expect("a healthy provider must actually answer the next request");
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
    } else {
        assert!(response.is_err(), "real upstream failure must terminate transport without fabricated completion or client error response");
    }
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

/// Asserts an exact requested model reached upstream exactly once.
async fn receipt_at(state: &Upstream, input: &str, model: &str) {
    let key = format!("{input}@{model}");
    assert_eq!(
        state.identity_receipts.lock().await.get(&key),
        Some(&1),
        "{key}: must reach upstream exactly once for that identity"
    );
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
        .route("/independent/v1/responses", post(independent_provider))
        .route("/fallback/v1/responses", post(fallback_provider))
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

    // 1. A single ordinary HTTP 429 latches a bounded hold on the exact
    //    provider/model/key identity; the failed key is never retried, and the
    //    request reselects the fallback instead.
    request(&client, &base, "main", "health-test:fail-isolated", false).await;
    receipt(&state, "health-test:fail-isolated").await;
    let hold_entries = pool(&client, &base).await;
    let hold = hold_entries
        .iter()
        .find(|e| {
            e["provider_id"] == "primary" && e["auth_alias"] == alias && e["model_id"] == "main"
        })
        .unwrap_or_else(|| panic!("a single 429 must hold the exact identity: {hold_entries:?}"));
    assert_eq!(hold["kind"], "probe", "the hold is a provider probe entry");
    assert_eq!(
        hold["state"], "blocked",
        "the held identity blocks selection"
    );
    assert!(
        hold["remaining_ms"].as_i64().unwrap_or(0) > 50_000,
        "the bounded hold lasts about one minute: {hold:?}"
    );

    // 2. The held identity is not retried: a second request on the same model
    //    must not reach the cooled key, and its transport still terminates
    //    without a fabricated success.
    request(
        &client,
        &base,
        "main",
        "health-test:held-not-retried",
        false,
    )
    .await;
    assert!(
        !state
            .receipts
            .lock()
            .await
            .contains_key("health-test:held-not-retried"),
        "a held provider/model/key must not receive another business attempt"
    );

    // 3. Sibling identities stay eligible: another model, another key and an
    //    independent provider all keep serving real business traffic.
    request(&client, &base, "other", "health-test:other-model", true).await;
    request(&client, &base, "sibling", "health-test:other-key", true).await;
    request(
        &client,
        &base,
        "independent",
        "health-test:independent",
        true,
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
        Some(&1),
        "the independent provider identity must receive its own request exactly once"
    );
    // Sibling successes must not release another identity's hold.
    assert!(
        pool(&client, &base)
            .await
            .iter()
            .any(|e| e["provider_id"] == "primary"
                && e["auth_alias"] == alias
                && e["model_id"] == "main"),
        "a sibling success must not release the exact held identity"
    );

    // 4. HTTP 500 on another model keeps its declared immediate threshold: one
    //    failure isolates that exact identity only.
    request(
        &client,
        &base,
        "other",
        "health-test:server-terminal",
        false,
    )
    .await;
    receipt_at(&state, "health-test:server-terminal", "other").await;
    assert!(
        pool(&client, &base)
            .await
            .iter()
            .any(|e| e["provider_id"] == "primary"
                && e["auth_alias"] == alias
                && e["model_id"] == "other"),
        "HTTP 500 retains its declared immediate threshold on the other model"
    );
    request(
        &client,
        &base,
        "sibling",
        "health-test:after-server-failure",
        true,
    )
    .await;
    receipt(&state, "health-test:after-server-failure").await;

    // 5. An auth failure keeps immediate isolation on its own identity.
    request(
        &client,
        &base,
        "independent",
        "health-test:auth-terminal",
        false,
    )
    .await;
    assert_eq!(
        state
            .receipts
            .lock()
            .await
            .get("independent:health-test:auth-terminal"),
        Some(&1),
        "the failed identity must be attempted exactly once, then reselected away"
    );
    assert!(
        pool(&client, &base)
            .await
            .iter()
            .any(|e| e["provider_id"] == "independent"),
        "auth failure retains immediate isolation"
    );

    handle.shutdown().await;
    shutdown.send(()).unwrap();
    upstream.await.unwrap();
    std::env::remove_var("V3_NO_FIRST_FAILURE_TEST_KEY");
}
