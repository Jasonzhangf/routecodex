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
    /// Scheduled/triggered observation probes observed on the primary path.
    probe_receipts: Mutex<usize>,
    /// Attempts keyed by `<input>@<requested model>`. Reselection may reach a
    /// different identity for the same request, so per-identity counting keeps
    /// "never retried the failed identity" provable.
    identity_receipts: Mutex<BTreeMap<String, usize>>,
    /// Attempts the mock answered with a provider failure, keyed by marker. A
    /// sustained-failure marker must provably be a real failure, so a 200 can
    /// never masquerade as a recorded failure (a declared success resets the
    /// v31 consecutive count).
    failure_receipts: Mutex<BTreeMap<String, usize>>,
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
        *state.probe_receipts.lock().await += 1;
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
        if input.starts_with("route-case:fail")
            || input.starts_with("route-case:auth")
            || input.starts_with("route-case:server")
        {
            *state
                .failure_receipts
                .lock()
                .await
                .entry(input.clone())
                .or_default() += 1;
        }
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
            .unwrap_or_else(|error| panic!("request marker={marker} failed: {error:?}"));
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
            .unwrap_or_else(|error| panic!("request marker={marker} failed: {error:?}"));
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

/// Wait until every expected `(provider_id, model_id)` identity has been seen
/// as a committed cooldown row.
///
/// v31: the consecutive ladder commits per complete identity at its own third
/// failure, and a committed row lives only for its own duration, so identities
/// reached at different times never have to coexist in the pool. Each identity
/// is therefore awaited independently and the returned rows are the last
/// committed snapshot seen for it.
async fn wait_for_identity_commits(
    client: &reqwest::Client,
    base: &str,
    expected: &[(&str, &str)],
) -> Vec<Value> {
    let mut last_pool: Vec<Value> = Vec::new();
    let outcome = timeout(Duration::from_secs(30), async {
        let mut seen: Vec<(String, String)> = Vec::new();
        let mut rows: Vec<Value> = Vec::new();
        loop {
            last_pool = pool(client, base).await;
            for entry in committed_only(last_pool.clone()) {
                let provider = entry["provider_id"].as_str().unwrap_or_default().to_string();
                let model = entry["model_id"].as_str().unwrap_or_default().to_string();
                if expected
                    .iter()
                    .any(|(want_provider, want_model)| *want_provider == provider && *want_model == model)
                    && !seen.contains(&(provider.clone(), model.clone()))
                {
                    seen.push((provider, model));
                    rows.push(entry.clone());
                }
            }
            if seen.len() == expected.len() {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    outcome.unwrap_or_else(|error| {
        panic!("every expected identity must reach a committed cooldown row: {error}; last pool={last_pool:?}")
    })
}

async fn wait_for_cooldown_count(
    client: &reqwest::Client,
    base: &str,
    expected: usize,
) -> Vec<Value> {
    let mut last = Vec::new();
    let outcome = timeout(Duration::from_secs(15), async {
        loop {
            let entries = committed_only(pool(client, base).await);
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

/// Committed cooldowns only. The pool API also lists pre-cool observation
/// substates for every claimed-but-uncommitted failure; those are visibility
/// holds, not committed cooldowns, so committed assertions filter them out.
fn committed_only(entries: Vec<Value>) -> Vec<Value> {
    entries
        .into_iter()
        .filter(|entry| entry["state"] != "pre_cool_observation")
        .collect()
}

async fn receipt(state: &Upstream, marker: &str) {
    assert_eq!(
        state.receipts.lock().await.get(marker),
        Some(&1),
        "{marker}: must reach upstream exactly once; no retry may hide a failure"
    );
}

/// Assert the mock really answered this business marker with a provider failure.
async fn failure_receipt(state: &Upstream, marker: &str) {
    assert_eq!(
        state.failure_receipts.lock().await.get(marker),
        Some(&1),
        "{marker}: the upstream must answer with a provider failure exactly once"
    );
}

async fn fallback_receipt(state: &Upstream, marker: &str) {
    assert_eq!(
        state.fallback_receipts.lock().await.get(marker),
        Some(&1),
        "{marker}: healthy fallback must receive exactly one actual attempt"
    );
}

fn assert_identities(raw: Vec<Value>, expected: &[(&str, &str, &str, &str)]) {
    let entries = committed_only(raw);
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
    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();

    let began = tokio::time::Instant::now();
    request(&client, &base, "main", "route-case:fail-isolated").await;
    receipt(&state, "route-case:fail-isolated").await;
    failure_receipt(&state, "route-case:fail-isolated").await;
    fallback_receipt(&state, "route-case:fail-isolated").await;
    assert_identities(pool(&client, &base).await, &[]);
    // v31: below the consecutive threshold no cooldown is committed and the
    // identity stays visible, so a fresh session legitimately reuses it. The
    // load-bearing property here is that records 1 and 2 cool nothing.
    request(&client, &base, "main", "route-case:fail-fresh-after-429").await;
    receipt(&state, "route-case:fail-fresh-after-429").await;
    failure_receipt(&state, "route-case:fail-fresh-after-429").await;
    assert_eq!(
        identity_count(&state, "route-case:fail-fresh-after-429", "main").await,
        1,
        "a still-visible identity is re-selected once, without a same-identity retry"
    );
    assert!(
        began.elapsed() < Duration::from_secs(3),
        "the second sustained failure must switch immediately instead of waiting for a cooldown or gate"
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
    // v31: the ladder counts consecutive BUSINESS failures per complete identity
    // and a declared success resets it. Reach the threshold through business
    // traffic only - no probe is driven here - so the two terminal identities
    // each record three consecutive failures before any cooldown exists.
    request(&client, &base, "main", "route-case:fail-ladder-main-third").await;
    receipt(&state, "route-case:fail-ladder-main-third").await;
    failure_receipt(&state, "route-case:fail-ladder-main-third").await;
    for marker in [
        "route-case:server-ladder-other-second",
        "route-case:server-ladder-other-third",
    ] {
        request_with_current_turn_call(
            &client,
            &base,
            "main",
            marker,
            "apply_patch",
            json!({"input":"*** Begin Patch
*** End Patch"}),
        )
        .await;
        receipt_at(&state, marker, "other").await;
    }
    let terminal_rows = wait_for_identity_commits(
        &client,
        &base,
        &[("primary", "main"), ("primary", "other")],
    )
    .await;
    assert_eq!(
        terminal_rows.len(),
        2,
        "each terminal identity commits its own row: {terminal_rows:?}"
    );
    for row in &terminal_rows {
        assert_eq!(row["provider_id"], "primary");
        assert_eq!(row["interface_id"], "default");
        assert_eq!(row["auth_alias"], alias);
        assert!(
            row["remaining_ms"].as_i64().unwrap_or(-1) > 0,
            "a committed row must still carry remaining visibility: {row:?}"
        );
    }
    // The committed rows make the identity unreal for new sessions: the fresh
    // session is served by the healthy sibling with no wait and primary sees no
    // business traffic at all.
    let began = tokio::time::Instant::now();
    request_with_current_turn_tool(
        &client,
        &base,
        "main",
        "route-case:after-server-failure",
        "cargo test",
    )
    .await;
    assert!(
        began.elapsed() < Duration::from_secs(3),
        "a committed cooldown must never delay a fresh session"
    );
    // The cooldown is per complete provider/interface/model/key identity, and this
    // fixture declares two auth aliases that share one env value, so an upstream
    // receipt cannot tell the cooled key from its visible sibling. The provable
    // v31 evidence is therefore that the request is served without waiting and
    // that the committed rows stay exactly what the ladder recorded - no new row,
    // no duplicate and no escalation while other identities keep serving.
    let after_rows = committed_only(pool(&client, &base).await);
    let cooled: Vec<(&str, &str, &str, &str)> = after_rows
        .iter()
        .map(|row| {
            (
                row["provider_id"].as_str().unwrap_or_default(),
                row["interface_id"].as_str().unwrap_or_default(),
                row["auth_alias"].as_str().unwrap_or_default(),
                row["model_id"].as_str().unwrap_or_default(),
            )
        })
        .collect();
    for exact in [
        ("primary", "default", alias.as_str(), "main"),
        ("primary", "default", alias.as_str(), "other"),
    ] {
        assert!(
            cooled.contains(&exact),
            "each terminal identity keeps its own ladder row: {cooled:?}"
        );
    }
    assert!(
        cooled.iter().all(|(provider, interface, key, model)| {
            *interface == "default"
                && ((*provider == "primary" && *key == alias)
                    || (*provider == "independent" && *key == "independent"))
                && (*model == "main" || *model == "other")
        }),
        "only the exact failed identities may cool: {cooled:?}"
    );
    for row in &after_rows {
        let remaining = row["remaining_ms"].as_i64().unwrap_or(-1);
        assert!(
            remaining > 0 && remaining <= 10_000,
            "a committed row must stay inside the 10s floor window: {row:?}"
        );
    }

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
    // Rows commit per identity at their own third failure, so the pool at this
    // point is a superset of the two terminal primary identities; each of them
    // must still be present with its own row.
    let mid_rows = committed_only(pool(&client, &base).await);
    for exact in [
        ("primary", "default", alias.as_str(), "main"),
        ("primary", "default", alias.as_str(), "other"),
    ] {
        assert!(
            mid_rows.iter().any(|row| {
                row["provider_id"] == exact.0
                    && row["interface_id"] == exact.1
                    && row["auth_alias"] == exact.2
                    && row["model_id"] == exact.3
            }),
            "each terminal identity keeps its own row: {mid_rows:?}"
        );
    }
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

/// v29 arbitration gate (a): with more than one available candidate in the
/// captured target, a real HTTP 429 on the primary identity switches the
/// request to the healthy candidate immediately - no request wait, no
/// same-identity retry, exactly one send to the failed identity.
///
/// v31 consecutive ladder basis: the streak is counted from REQUEST failures
/// per complete provider/interface/model/key identity (`3 -> 10s`, `5 -> 30s`,
/// `10 -> 1h`), it changes only that identity's visibility in the candidate
/// pool, and a declared success resets it. Below three consecutive failures
/// no cooldown is committed and the identity stays visible; a failed recovery
/// probe advances only its own cadence and never the business ladder. Only at
/// the third consecutive failure does the exact identity enter the cooldown
/// pool at the 10s floor, while sibling models, keys and the healthy fallback
/// stay usable throughout.
#[tokio::test]
async fn v29_arbitration_multi_candidate_sustained_429_cooldown_is_visibility_only() {
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
    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap();

    // Phase 1: one business 429 on the exact identity. The request itself
    // completes through the healthy fallback with no wait and the failed
    // identity receives exactly one send.
    let began = tokio::time::Instant::now();
    request(&client, &base, "main", "route-case:fail-v29-four29-one").await;
    receipt(&state, "route-case:fail-v29-four29-one").await;
    fallback_receipt(&state, "route-case:fail-v29-four29-one").await;
    assert!(
        began.elapsed() < Duration::from_secs(3),
        "the fallback completion must not wait on the failed identity's cooldown or recovery"
    );
    assert_eq!(
        identity_count(&state, "route-case:fail-v29-four29-one", "main").await,
        1,
        "the failed identity must receive exactly one business send"
    );
    // Below the ladder threshold no committed cooldown exists: the pool may
    // list the identity only as a pre-cool observation substate.
    assert!(
        committed_cooldowns(&client, &base).await.is_empty(),
        "one business 429 must not commit a cooldown"
    );

    // Phase 2 (v31 ladder basis): the consecutive streak is counted from
    // REQUEST failures per complete provider/interface/model/key identity.
    // Requests 2 and 3 hit the same still-visible identity again; each one
    // switches to the healthy sibling inside the same request - immediate, no
    // wait, no same-identity retry, no fabricated success - and only the third
    // consecutive failure commits the exact identity at the 10s floor.
    for marker in [
        "route-case:fail-v29-four29-two",
        "route-case:fail-v29-four29-three",
    ] {
        let began = tokio::time::Instant::now();
        request(&client, &base, "main", marker).await;
        receipt(&state, marker).await;
        fallback_receipt(&state, marker).await;
        assert!(
            began.elapsed() < Duration::from_secs(3),
            "each sustained-429 request must switch immediately instead of waiting: {marker}"
        );
        assert_eq!(
            identity_count(&state, marker, "main").await,
            1,
            "the failed identity must receive exactly one business send per request: {marker}"
        );
        if marker.ends_with("two") {
            assert!(
                committed_cooldowns(&client, &base).await.is_empty(),
                "two consecutive business failures must not commit a cooldown"
            );
        }
    }
    let entries = committed_cooldowns(&client, &base).await;
    assert_eq!(
        entries.len(),
        1,
        "only the exact sustained-429 identity may cool: {entries:?}"
    );
    let entry = &entries[0];
    assert_eq!(entry["provider_id"], "primary");
    assert_eq!(entry["interface_id"], "default");
    assert_eq!(entry["auth_alias"], alias);
    assert_eq!(entry["model_id"], "main");
    let remaining = entry["remaining_ms"].as_i64().unwrap_or(-1);
    assert!(
        remaining > 0 && remaining <= 10_000,
        "the v31 ladder floor for 3 consecutive failures is 10s: {entry:?}"
    );

    // Phase 3 (visibility only): the cooled identity is skipped for a fresh
    // session and served by the healthy sibling with no wait, while sibling
    // models, sibling keys, the independent provider and a concurrent healthy
    // request stay usable and unblocked.
    let began = tokio::time::Instant::now();
    let skipped_task = {
        let client = client.clone();
        let base = base.clone();
        tokio::spawn(async move {
            request_with_current_turn_tool(
                &client,
                &base,
                "main",
                "route-case:fail-v29-after-cooldown",
                "cargo test",
            )
            .await;
        })
    };
    let concurrent_task = {
        let client = client.clone();
        let base = base.clone();
        tokio::spawn(async move {
            request_with_current_turn_tool(
                &client,
                &base,
                "main",
                "route-case:healthy-concurrent",
                "rg -n route src",
            )
            .await;
        })
    };
    skipped_task.await.expect("the skipped-session request must finish");
    concurrent_task
        .await
        .expect("the concurrent healthy request must not be blocked");
    assert!(
        began.elapsed() < Duration::from_secs(4),
        "a cooled identity must not delay the request or a concurrent healthy request"
    );
    assert!(
        identity_count(&state, "route-case:fail-v29-after-cooldown", "main").await <= 1,
        "a cooled identity must not be retried inside one request"
    );
    // The cooldown is visibility only and per complete identity: the row stays a
    // single 10s-floor entry (no escalation, no duplicate) while other identities
    // of the same provider, the sibling model, the sibling key and the
    // independent provider keep serving.
    assert_identities(
        pool(&client, &base).await,
        &[("primary", "default", &alias, "main")],
    );
    assert_identities(
        committed_cooldowns(&client, &base).await,
        &[("primary", "default", &alias, "main")],
    );
    request_with_current_turn_call(
        &client,
        &base,
        "main",
        "route-case:healthy-sibling-model",
        "apply_patch",
        json!({"input":"*** Begin Patch
*** End Patch"}),
    )
    .await;
    request_with_current_turn_tool(&client, &base, "main", "route-case:healthy-sibling-key", "cargo test")
        .await;

    handle.shutdown().await;
    shutdown.send(()).unwrap();
    upstream.await.unwrap();
    std::env::remove_var("V3_NO_FIRST_FAILURE_TEST_KEY");
}

/// Committed cooldown entries only: observation/probe substates stay listed
/// by the pool API (AGENTS.md cooldown substates rule) but are not committed
/// cooldowns, so the ladder assertions filter them out.
async fn committed_cooldowns(client: &reqwest::Client, base: &str) -> Vec<Value> {
    pool(client, base)
        .await
        .into_iter()
        .filter(|entry| {
            if entry["state"] == "pre_cool_observation" {
                return false;
            }
            // A committed cooldown always carries an expiry. A probe-kind
            // entry in the `blocked` state is the committed cooldown the
            // consecutive ladder produces for a provider-scope identity, so it
            // counts here just like a session/auth-key entry; a pre-cool
            // observation substate never has `until_ms`.
            entry["until_ms"].is_number()
                || entry["kind"] == "session"
                || entry["kind"] == "auth_key"
                || entry["state"] == "session_cooldown"
                || entry["state"] == "auth_key_cooldown"
        })
        .collect()
}
