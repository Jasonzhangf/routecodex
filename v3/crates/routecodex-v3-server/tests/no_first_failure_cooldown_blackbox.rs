//! Public regression: isolated recoverable failures keep the exact key eligible.
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
}

async fn provider(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    let input = body["input"].as_str().unwrap_or("");
    // Startup/recovery probes are distinct from business receipts.
    if input.starts_with("health-test:") {
        *state
            .receipts
            .lock()
            .await
            .entry(input.to_string())
            .or_default() += 1;
    }
    if input.starts_with("health-test:fail") || input.starts_with("health-test:auth") {
        let (status, kind) = if input.starts_with("health-test:auth") {
            (StatusCode::UNAUTHORIZED, "invalid_api_key")
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, "server_error")
        };
        return Response::builder().status(status).header("content-type", "application/json")
            .body(Body::from(json!({"error":{"type":kind,"code":kind,"message":"controlled real upstream failure"}}).to_string())).unwrap();
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
  {{ step = "project", status = 503, reason_code = "provider_failure", message_mode = "code_only" }},
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
base_url = "{upstream}/v1"
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "independent", env = "V3_NO_FIRST_FAILURE_TEST_KEY" }}] }}
[providers.independent.models.main]
wire_name = "main"
supports_streaming = true
[debug]
log_console = false
snapshots = false
codex_samples = false
[route_groups.health.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "primary", model = "main", key = "{alias}", priority = 100 }}]
[route_groups.health.pools.other]
match = {{ models = ["other"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "primary", model = "other", key = "{alias}", priority = 100 }}]
[route_groups.health.pools.sibling]
match = {{ models = ["sibling"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "primary", model = "main", key = "sibling", priority = 100 }}]
[route_groups.health.pools.independent]
match = {{ models = ["independent"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "independent", model = "main", key = "independent", priority = 100 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn request(client: &reqwest::Client, base: &str, model: &str, marker: &str, success: bool) {
    let response = timeout(
        Duration::from_secs(2),
        client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&json!({"model":model,"input":marker,"stream":false}))
            .send(),
    )
    .await
    .expect("request must finish without recovery wait");
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

    request(&client, &base, "main", "health-test:fail-isolated", false).await;
    receipt(&state, "health-test:fail-isolated").await;
    assert!(
        pool(&client, &base)
            .await
            .iter()
            .all(|e| e["provider_id"] != "primary"),
        "first recoverable HTTP 500 must not create global cooldown"
    );
    request(&client, &base, "main", "health-test:success-reset", true).await;
    receipt(&state, "health-test:success-reset").await;

    request(
        &client,
        &base,
        "main",
        "health-test:fail-after-reset",
        false,
    )
    .await;
    receipt(&state, "health-test:fail-after-reset").await;
    assert!(
        pool(&client, &base)
            .await
            .iter()
            .all(|e| e["provider_id"] != "primary"),
        "a real success must reset the failure streak"
    );
    request(&client, &base, "main", "health-test:fail-repeat", false).await;
    receipt(&state, "health-test:fail-repeat").await;
    let entries = pool(&client, &base).await;
    assert!(
        entries.iter().any(|e| e["provider_id"] == "primary"
            && e["auth_alias"] == alias
            && e["model_id"] == "main"),
        "consecutive second HTTP 500 must cool exact provider/key/model: {entries:?}"
    );
    request(&client, &base, "main", "health-test:blocked", false).await;
    assert!(
        !state
            .receipts
            .lock()
            .await
            .contains_key("health-test:blocked"),
        "cooled key must not receive another business attempt"
    );
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
    receipt(&state, "health-test:independent").await;
    assert!(
        pool(&client, &base)
            .await
            .iter()
            .any(|e| e["provider_id"] == "primary"
                && e["auth_alias"] == alias
                && e["model_id"] == "main"),
        "sibling success must not reset another identity's streak/cooldown"
    );

    request(
        &client,
        &base,
        "independent",
        "health-test:auth-terminal",
        false,
    )
    .await;
    receipt(&state, "health-test:auth-terminal").await;
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
