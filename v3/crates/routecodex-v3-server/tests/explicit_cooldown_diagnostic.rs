//! Explicit paid diagnostics use the real operator route and aggregate owner.
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use routecodex_v3_config::V3ConfigStore;
use serde_json::{json, Value};
use std::{
    future::IntoFuture,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{
    sync::{oneshot, Semaphore},
    time::{sleep, timeout, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

struct Upstream {
    sends: AtomicUsize,
    mode: AtomicUsize,
    release: Semaphore,
}

async fn provider(State(state): State<Arc<Upstream>>, Json(body): Json<Value>) -> StatusCode {
    assert_eq!(body["model"], "test");
    assert!(body.to_string().contains("ping; reply pong"));
    state.sends.fetch_add(1, Ordering::SeqCst);
    match state.mode.load(Ordering::SeqCst) {
        1 => StatusCode::SERVICE_UNAVAILABLE,
        2 => {
            state.release.acquire().await.unwrap().forget();
            StatusCode::OK
        }
        _ => StatusCode::OK,
    }
}

async fn pool(client: &reqwest::Client, base: &str) -> Value {
    let mut body: Value = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    for entry in body["entries"].as_array_mut().unwrap() {
        entry.as_object_mut().unwrap().remove("remaining_ms");
    }
    body["entries"].clone()
}

#[tokio::test]
async fn explicit_paid_diagnostic_is_bounded_single_flight_and_observation_only_public_http() {
    let home = std::env::temp_dir().join(format!("rcc-explicit-diagnostic-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let previous_home = std::env::var_os("HOME");
    std::env::set_var("HOME", &home);
    std::env::set_var("V3_EXPLICIT_DIAGNOSTIC_TEST_KEY", "diagnostic-test-secret");
    let upstream = Arc::new(Upstream {
        sends: AtomicUsize::new(0),
        mode: AtomicUsize::new(0),
        release: Semaphore::new(0),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let (stop, stopped) = oneshot::channel();
    let upstream_task = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(provider))
                .with_state(upstream.clone()),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .into_future(),
    );
    let config = home.join("config.toml");
    let port = test_ports::free_port();
    std::fs::write(&config, format!(r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
[providers.test]
default_model = "test"
request_timeout_ms = 250
sse_first_frame_timeout_ms = 250
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_EXPLICIT_DIAGNOSTIC_TEST_KEY" }}] }}
[providers.test.interfaces.default]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
[providers.test.models.test]
[route_groups.default.pools.default]
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#)).unwrap();
    let snapshot = V3ConfigStore::new(&config)
        .load_snapshot_with_source_identity()
        .unwrap();
    let handle = routecodex_v3_server::spawn_v3_server_aggregate(snapshot.manifest)
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let identity = json!({"provider_id":"test", "auth_alias":"key", "model_id":"test"});
    let probe_url = format!("{base}/_routecodex/health/cooldown-pool/probe");
    let add = client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({"provider_id":"test", "auth_alias":"key", "model_id":"test", "kind":"probe", "duration_ms":60_000}))
        .send().await.unwrap();
    assert_eq!(add.status(), 200);
    let ordinary: Value = client
        .post(&probe_url)
        .json(&identity)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ordinary["scheduled"], true);
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        upstream.sends.load(Ordering::SeqCst),
        0,
        "default action must be free"
    );
    let before = pool(&client, &base).await;
    assert!(!before.as_array().unwrap().is_empty());
    let mut paid = identity.clone();
    paid["allow_paid_diagnostic"] = json!(true);
    let mut incomplete = paid.clone();
    incomplete.as_object_mut().unwrap().remove("model_id");
    assert_eq!(
        client
            .post(&probe_url)
            .json(&incomplete)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        upstream.sends.load(Ordering::SeqCst),
        0,
        "incomplete identity cannot send"
    );
    for (mode, expected) in [(0, "succeeded"), (1, "failed")] {
        upstream.mode.store(mode, Ordering::SeqCst);
        let sends = upstream.sends.load(Ordering::SeqCst);
        let result: Value = client
            .post(&probe_url)
            .json(&paid)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["diagnostic"]["status"], expected, "{result}");
        if mode == 1 {
            assert_eq!(result["diagnostic"]["http_status"], 503);
        }
        assert_eq!(upstream.sends.load(Ordering::SeqCst), sends + 1);
        assert_eq!(
            pool(&client, &base).await,
            before,
            "diagnostic must not settle health"
        );
    }
    upstream.mode.store(2, Ordering::SeqCst);
    let sends = upstream.sends.load(Ordering::SeqCst);
    let first = client.post(&probe_url).json(&paid).send();
    let duplicate = async {
        timeout(Duration::from_secs(2), async {
            while upstream.sends.load(Ordering::SeqCst) == sends {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let result: Value = client
            .post(&probe_url)
            .json(&paid)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["diagnostic"]["status"], "already_owned", "{result}");
    };
    let (first, ()) = tokio::join!(first, duplicate);
    let result: Value = first.unwrap().json().await.unwrap();
    assert_eq!(result["diagnostic"]["status"], "timed_out", "{result}");
    assert_eq!(upstream.sends.load(Ordering::SeqCst), sends + 1);
    assert_eq!(pool(&client, &base).await, before);
    upstream.release.add_permits(1);
    upstream.mode.store(0, Ordering::SeqCst);
    let result: Value = client
        .post(&probe_url)
        .json(&paid)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        result["diagnostic"]["status"], "succeeded",
        "timeout must release ownership: {result}"
    );
    assert_eq!(upstream.sends.load(Ordering::SeqCst), sends + 2);
    assert_eq!(pool(&client, &base).await, before);
    // Aggregate shutdown cancels its in-flight diagnostic rather than leaving
    // detached provider work or waiting for another operator request.
    upstream.mode.store(2, Ordering::SeqCst);
    let sends = upstream.sends.load(Ordering::SeqCst);
    let pending = client.post(&probe_url).json(&paid).send();
    let shutdown = async {
        timeout(Duration::from_secs(2), async {
            while upstream.sends.load(Ordering::SeqCst) == sends {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        timeout(Duration::from_secs(2), handle.shutdown())
            .await
            .unwrap();
    };
    let _ = tokio::join!(pending, shutdown);
    upstream.release.add_permits(1);
    assert_eq!(upstream.sends.load(Ordering::SeqCst), sends + 1);
    stop.send(()).unwrap();
    upstream_task.await.unwrap().unwrap();
    assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    assert!(std::net::TcpListener::bind(("127.0.0.1", upstream_port)).is_ok());
    match previous_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    std::env::remove_var("V3_EXPLICIT_DIAGNOSTIC_TEST_KEY");
    std::fs::remove_dir_all(home).unwrap();
}
