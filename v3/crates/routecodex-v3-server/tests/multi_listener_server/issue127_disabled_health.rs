//! Issue #127 public-entry regression: a provider whose declared health is
//! disabled must ignore a matching persisted cooldown and must never write a
//! new automatic cooldown.
//!
//! Test ID: issue127_disabled_health_persistence_direct_public_blackbox
//! Command:
//!   CARGO_NET_OFFLINE=true cargo +stable test --manifest-path v3/Cargo.toml \
//!     -p routecodex-v3-server --test multi_listener_server \
//!     issue127_disabled_health_persistence_direct_public_blackbox -- --nocapture
//!
//! Every assertion enters through the real HTTP `/v1/responses` endpoint of a
//! spawned aggregate listener that talks to one locally controlled upstream.
//! The seeded cooldown lives in a caller-owned state file selected with
//! `ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE`, so no production health state is
//! read, written or pruned by this case.

use super::*;
use axum::Json;
use std::collections::BTreeMap;
use std::env;

/// Far-future deadline written into the seed file. A fresh automatic cooldown
/// would replace it with `now + cooldown_ms`, so any other value proves a write.
const ISSUE127_SEEDED_BLOCKED_UNTIL_MS: u64 = 4_000_000_000_000;
const ISSUE127_COOLDOWN_MS: u64 = 300_000;
const ISSUE127_AUTH_ENV: &str = "V3_ISSUE127_DISABLED_HEALTH_KEY";

#[derive(Default)]
struct Issue127Upstream {
    receipts: Mutex<BTreeMap<String, usize>>,
    probes: Mutex<u32>,
}

async fn issue127_upstream(
    State(state): State<Arc<Issue127Upstream>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    assert_eq!(headers["authorization"], "Bearer controlled-issue127-key");
    assert!(matches!(
        body["model"].as_str(),
        Some("main" | "independent")
    ));
    // Recovery probes share the provider endpoint. Failing them keeps a seeded
    // cooldown in place for the health-enabled control.
    if body.to_string().contains("ping; reply pong") {
        *state.probes.lock().await += 1;
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"type":"server_error","code":"server_error","message":"controlled probe failure"}})
                    .to_string(),
            ))
            .unwrap();
    }
    let marker = body["input"]
        .as_str()
        .unwrap_or("<missing-input>")
        .to_string();
    *state
        .receipts
        .lock()
        .await
        .entry(marker.clone())
        .or_default() += 1;
    if marker.starts_with("issue127-fail") {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"type":"server_error","code":"server_error","message":"controlled real upstream failure"}})
                    .to_string(),
            ))
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "resp_issue127",
                "object": "response",
                "status": "completed",
                "model": body["model"],
                "output": [{
                    "type": "message",
                    "id": "msg_issue127",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": marker, "annotations": []}]
                }]
            })
            .to_string(),
        ))
        .unwrap()
}

fn issue127_manifest(
    port: u16,
    upstream_base: &str,
    health_enabled: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = HUB_V1_TEST_DECLARATION;
    let source = format!(
        r#"
version = 3
{declaration}
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
[servers.main.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
[providers.primary]
type = "responses"
base_url = "{upstream_base}"
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{ISSUE127_AUTH_ENV}" }}] }}
health = {{ enabled = {health_enabled}, failure_threshold = 1, cooldown_ms = {ISSUE127_COOLDOWN_MS} }}
[providers.primary.models.main]
wire_name = "main"
[providers.independent]
type = "responses"
base_url = "{upstream_base}"
default_model = "independent"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{ISSUE127_AUTH_ENV}" }}] }}
health = {{ enabled = {health_enabled}, failure_threshold = 1, cooldown_ms = {ISSUE127_COOLDOWN_MS} }}
[providers.independent.models.independent]
wire_name = "independent"
[debug]
log_console = false
snapshots = false
codex_samples = false
dry_run = false
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "primary", model = "main", key = "key", priority = 100 }}]
[route_groups.default.pools.independent]
match = {{ models = ["independent"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "independent", model = "independent", key = "key", priority = 100 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

/// Writes a durable `RateLimit` cooldown for `primary/default/key/main`, the
/// exact identity that the disabled provider must ignore.
fn issue127_write_seed(path: &std::path::Path) {
    let seed = json!({
        "schema_version": 3,
        "entries": [[
            {
                "provider_id": "primary",
                "interface_id": "default",
                "auth_alias": "key",
                "model_id": "main",
                "failure_class": "RateLimit"
            },
            {
                "blocked_until_ms": ISSUE127_SEEDED_BLOCKED_UNTIL_MS,
                "next_probe_at_ms": ISSUE127_SEEDED_BLOCKED_UNTIL_MS,
                "probe_in_flight": false
            }
        ]]
    });
    fs::write(path, serde_json::to_vec_pretty(&seed).unwrap()).unwrap();
}

fn issue127_seed_entries(path: &std::path::Path) -> Vec<Value> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => panic!("cannot inspect persisted cooldown: {error}"),
    };
    let value: Value = serde_json::from_str(&raw).unwrap();
    value["entries"]
        .as_array()
        .expect("typed persisted entries")
        .clone()
}

/// True when the persisted file holds a cooldown for the seeded identity whose
/// deadline is not the far-future sentinel, i.e. a fresh automatic cooldown.
fn issue127_has_fresh_automatic_cooldown(path: &std::path::Path) -> bool {
    issue127_seed_entries(path).iter().any(|entry| {
        let key = &entry[0];
        key["provider_id"] == json!("primary")
            && key["model_id"] == json!("main")
            && entry[1]["blocked_until_ms"].as_u64() != Some(ISSUE127_SEEDED_BLOCKED_UNTIL_MS)
    })
}

async fn issue127_send(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    marker: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    timeout(
        Duration::from_secs(5),
        client
            .post(format!("{base}/v1/responses"))
            .header("session-id", marker)
            .header("thread-id", marker)
            .json(&json!({"model": model, "input": marker, "stream": false}))
            .send(),
    )
    .await
    .expect("request must settle without recovery wait")
}

async fn issue127_receipts(state: &Issue127Upstream, marker: &str) -> usize {
    state
        .receipts
        .lock()
        .await
        .get(marker)
        .copied()
        .unwrap_or(0)
}

async fn issue127_pool(client: &reqwest::Client, base: &str) -> Vec<Value> {
    let response = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.json::<Value>().await.unwrap()["entries"]
        .as_array()
        .expect("typed public cooldown entries")
        .clone()
}

async fn issue127_start_upstream() -> (
    String,
    Arc<Issue127Upstream>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(Issue127Upstream::default());
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let app = Router::new()
        .route("/v1/responses", post(issue127_upstream))
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{addr}/v1"), state, shutdown_tx, task)
}

#[tokio::test]
async fn issue127_disabled_health_persistence_direct_public_blackbox() {
    let _guard = TEST_LOCK.lock().await;
    env::set_var(ISSUE127_AUTH_ENV, "controlled-issue127-key");
    let _home_guard = TestHomeGuard::new("issue127-disabled-health");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();

    let (upstream_base, upstream, upstream_shutdown, upstream_task) =
        issue127_start_upstream().await;

    let disabled_seed = std::env::temp_dir().join(format!(
        "routecodex-issue127-disabled-seed-{}.json",
        std::process::id()
    ));
    issue127_write_seed(&disabled_seed);
    env::set_var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE", &disabled_seed);
    let handle = spawn_v3_server_aggregate(issue127_manifest(free_port(), &upstream_base, false))
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);

    // 1) A matching persisted cooldown must not pre-exhaust the identity.
    let response = issue127_send(&client, &base, "main", "issue127-ignored-seed")
        .await
        .expect("health-disabled provider must still attempt the seeded identity");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains("issue127-ignored-seed"),
        "seeded identity must return the real upstream payload: {body}"
    );
    assert_eq!(
        issue127_receipts(&upstream, "issue127-ignored-seed").await,
        1,
        "the ignored cooldown must not block the first business send"
    );

    // 2) A real upstream failure reaches the upstream, closes only this
    //    transport without a client error payload, and writes no cooldown.
    let response = issue127_send(&client, &base, "main", "issue127-fail-real").await;
    assert!(
        response.is_err(),
        "exhausted real provider failure must close the transport without a fabricated client response"
    );
    assert!(
        issue127_receipts(&upstream, "issue127-fail-real").await >= 1,
        "the real failure must reach the controlled upstream"
    );

    // 3) A fresh request still reaches the same identity.
    let response = issue127_send(&client, &base, "main", "issue127-fresh-after-failure")
        .await
        .expect("health-disabled provider must remain selectable after a real failure");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(body.contains("issue127-fresh-after-failure"), "{body}");
    assert_eq!(
        issue127_receipts(&upstream, "issue127-fresh-after-failure").await,
        1,
        "no automatic cooldown may block the follow-up request"
    );

    // 4) An isolated identity is unaffected by the seeded cooldown.
    let response = issue127_send(&client, &base, "independent", "issue127-isolated-healthy")
        .await
        .expect("an unseeded identity must stay reachable");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(body.contains("issue127-isolated-healthy"), "{body}");

    // 5) The health projection must not expose a cooldown for the identity.
    let entries = issue127_pool(&client, &base).await;
    assert!(
        entries
            .iter()
            .all(|entry| !(entry["provider_id"] == json!("primary")
                && entry["model_id"] == json!("main"))),
        "health-disabled provider must not project a cooldown: {entries:?}"
    );

    let persist_failures = handle.shutdown().await;
    assert!(
        persist_failures.is_empty(),
        "persistence flush must succeed: {persist_failures:?}"
    );
    assert!(
        !issue127_has_fresh_automatic_cooldown(&disabled_seed),
        "health-disabled provider must not persist a fresh automatic cooldown"
    );

    // 6) Health-enabled control: the same seed must be honored, proving the
    //    fixture really can catch cooldown contamination.
    let enabled_seed = std::env::temp_dir().join(format!(
        "routecodex-issue127-enabled-seed-{}.json",
        std::process::id()
    ));
    issue127_write_seed(&enabled_seed);
    env::set_var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE", &enabled_seed);
    let control = spawn_v3_server_aggregate(issue127_manifest(free_port(), &upstream_base, true))
        .await
        .unwrap();
    let control_base = format!("http://{}", control.listeners[0].addr);
    let response = issue127_send(&client, &control_base, "main", "issue127-control-blocked").await;
    assert!(
        response.is_err(),
        "a health-enabled provider must honor the seeded cooldown and close the transport"
    );
    assert_eq!(
        issue127_receipts(&upstream, "issue127-control-blocked").await,
        0,
        "the seeded cooldown must keep the business request away from the upstream"
    );
    // The control's isolated identity still succeeds with health enabled.
    let response = issue127_send(
        &client,
        &control_base,
        "independent",
        "issue127-control-independent",
    )
    .await
    .expect("an unseeded identity must stay reachable with health enabled");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(body.contains("issue127-control-independent"), "{body}");
    let control_persist_failures = control.shutdown().await;
    assert!(
        control_persist_failures.is_empty(),
        "control persistence flush must succeed: {control_persist_failures:?}"
    );

    upstream_shutdown.send(()).unwrap();
    upstream_task.await.unwrap();
    let _ = fs::remove_file(&disabled_seed);
    let _ = fs::remove_file(&enabled_seed);
    env::remove_var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE");
    env::remove_var(ISSUE127_AUTH_ENV);
}
