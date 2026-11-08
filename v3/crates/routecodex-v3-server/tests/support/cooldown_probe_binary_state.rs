use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::sync::{
    atomic::{AtomicU16, AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration, Instant};

#[derive(Default)]
struct Upstream {
    events: Mutex<Vec<(String, bool)>>,
    failures_remaining: AtomicUsize,
    failure_status: AtomicU16,
    probe_status: AtomicU16,
}

impl Upstream {
    fn with_failure(status: u16, failures: usize) -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::new(Vec::new()),
            failures_remaining: AtomicUsize::new(failures),
            failure_status: AtomicU16::new(status),
            probe_status: AtomicU16::new(StatusCode::OK.as_u16()),
        })
    }

    fn take_failure(&self) -> bool {
        self.failures_remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
    }
}

fn is_probe(body: &Value) -> bool {
    body.get("input").is_some_and(Value::is_array)
        || body.to_string().contains("ping; reply pong")
        || body
            .to_string()
            .contains("Reply exactly OK. Do not call tools.")
}

async fn upstream(
    State(state): State<Arc<Upstream>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(body["model"], "test");
    let auth = headers["authorization"].to_str().unwrap().to_string();
    let probe = is_probe(&body);
    state.events.lock().await.push((auth.clone(), probe));

    if probe {
        let status = state.probe_status.load(Ordering::SeqCst);
        if (200..300).contains(&status) {
            return json_response(
                status,
                json!({
                    "id": "probe",
                    "object": "response",
                    "status": "completed",
                    "model": "test",
                    "output": []
                }),
            );
        }
        return json_response(
            status,
            json!({"error":{"message":"controlled probe failure"}}),
        );
    }

    if auth == "Bearer controlled-secret" && state.take_failure() {
        let status = state.failure_status.load(Ordering::SeqCst);
        return json_response(
            status,
            json!({"error":{"message":"controlled provider failure"}}),
        );
    }

    json_response(
        StatusCode::OK.as_u16(),
        json!({
            "id": "resp-binary-state",
            "object": "response",
            "status": "completed",
            "model": "test",
            "output": [{
                "id": "msg-binary-state",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type":"output_text","text":auth,"annotations":[]}]
            }]
        }),
    )
}

fn json_response(status: u16, body: Value) -> Response {
    (
        StatusCode::from_u16(status).expect("fixture status must be valid"),
        Json(body),
    )
        .into_response()
}

async fn business(client: &reqwest::Client, managed: &Managed) -> String {
    let response = client
        .post(format!("{}/v1/responses", managed.base))
        .json(&json!({"model":"test","input":"binary state business","stream":false}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.text().await.unwrap()
}

async fn committed_exact_entries(
    client: &reqwest::Client,
    managed: &Managed,
    provider_id: &str,
) -> Vec<Value> {
    pool_entries(client, managed.pool_url())
        .await
        .into_iter()
        .filter(|entry| {
            entry["provider_id"] == provider_id
                && entry["interface_id"] == "default"
                && entry["auth_alias"] == "key"
                && entry["model_id"] == "test"
                && entry["state"] != "pre_cool_observation"
        })
        .collect()
}

async fn exact_events(state: &Arc<Upstream>, auth: &str, probe: bool) -> usize {
    state
        .events
        .lock()
        .await
        .iter()
        .filter(|(seen_auth, seen_probe)| seen_auth == auth && *seen_probe == probe)
        .count()
}

async fn run_v31_recovery_case(
    label: &str,
    failure_status: u16,
    failures: usize,
    failed_probe: bool,
) {
    let _guard = TEST_LOCK.lock().await;
    let state = Upstream::with_failure(failure_status, failures);
    let provider_id = format!("binary_state_{}", label.replace('-', "_"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let task = tokio::spawn({
        let state = state.clone();
        async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/v1/responses", post(upstream))
                    .with_state(state),
            )
            .await
            .unwrap();
        }
    });
    env::set_var("V3_COOLDOWN_BINARY_SPARE_KEY", "spare-secret");
    let execution = hub_v1_fixture::hub_v1_test_declaration();
    let managed = Managed::start_source(label, false, |port| format!(
        r#"
version = 3
[servers.main]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.{provider_id}]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}, {{ alias = "spare", env = "V3_COOLDOWN_BINARY_SPARE_KEY" }}] }}
[providers.{provider_id}.models.test]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "{provider_id}", model = "test", key = "key", priority = 100 }},
  {{ kind = "provider_model", provider = "{provider_id}", model = "test", key = "spare", priority = 1 }}
]
"#
    )).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .unwrap();

    for _ in 0..failures {
        let started = Instant::now();
        let body = business(&client, &managed).await;
        assert!(
            body.contains("spare-secret"),
            "failed identity must switch immediately: {body}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "request must not wait on cooldown/probe state"
        );
    }
    assert_eq!(
        exact_events(&state, "Bearer controlled-secret", false).await,
        failures,
        "each failed identity must receive one business send: {:?}",
        state.events.lock().await
    );

    let committed = committed_exact_entries(&client, &managed, &provider_id).await;
    if failures < 3 {
        assert!(
            committed.is_empty(),
            "below the v31 ladder threshold only pre-cool observation is allowed: {committed:?}"
        );
        let body = business(&client, &managed).await;
        assert!(
            body.contains("controlled-secret"),
            "the visible identity must remain routable: {body}"
        );
        managed.finish().await;
        task.abort();
        let _ = task.await;
        env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
        return;
    }

    assert_eq!(
        committed.len(),
        1,
        "only the exact identity may cool: {committed:?}"
    );
    let row = &committed[0];
    let remaining = row["remaining_ms"].as_u64().unwrap_or_default();
    assert!(
        remaining > 0 && remaining <= 10_000,
        "three consecutive failures must use the 10s floor: {row:?}"
    );

    let started = Instant::now();
    let body = business(&client, &managed).await;
    assert!(
        body.contains("spare-secret"),
        "a cooled identity must be skipped: {body}"
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(
        exact_events(&state, "Bearer controlled-secret", false).await,
        failures,
        "a cooled identity must not be retried by a fresh request"
    );

    if failed_probe {
        state.probe_status.store(503, Ordering::SeqCst);
        let (status, body) = post_json(
            &client,
            managed.probe_url(),
            json!({"provider_id":provider_id,"interface_id":"default","auth_alias":"key","model_id":"test"}),
        )
        .await;
        assert_eq!(status, 200, "probe scheduling must succeed: {body}");
        sleep(Duration::from_millis(150)).await;
        assert_eq!(
            committed_exact_entries(&client, &managed, &provider_id)
                .await
                .len(),
            1
        );
        let body = business(&client, &managed).await;
        assert!(
            body.contains("spare-secret"),
            "failed probe must not block fallback: {body}"
        );
    }

    state.probe_status.store(200, Ordering::SeqCst);
    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({"provider_id":provider_id,"interface_id":"default","auth_alias":"key","model_id":"test"}),
    )
    .await;
    assert_eq!(status, 200, "matching probe must be accepted: {body}");
    timeout(Duration::from_secs(8), async {
        loop {
            if committed_exact_entries(&client, &managed, &provider_id)
                .await
                .is_empty()
            {
                break;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("matching 2xx probe must restore the exact identity");
    let body = business(&client, &managed).await;
    assert!(
        body.contains("controlled-secret"),
        "the recovered identity must route again: {body}"
    );
    assert!(exact_events(&state, "Bearer controlled-secret", true).await >= 1);

    managed.finish().await;
    task.abort();
    let _ = task.await;
    env::remove_var("V3_COOLDOWN_BINARY_SPARE_KEY");
}

#[tokio::test]
async fn health_neutral_429_then_manual_probe_2xx_restores_exact_key() {
    run_v31_recovery_case("429-manual-probe", 429, 3, false).await;
}

#[tokio::test]
async fn in_flight_business_success_wakes_exact_429_gate_before_backoff() {
    run_v31_recovery_case("429-no-wait", 429, 1, false).await;
}

#[tokio::test]
async fn non429_hold_preserves_healthy_fallback_and_matching_success_cancels_cooling() {
    run_v31_recovery_case("503-manual-probe", 503, 3, false).await;
}

#[tokio::test]
async fn non429_business_success_supersedes_in_flight_observation_failure() {
    run_v31_recovery_case("503-pre-cool", 503, 1, false).await;
}

#[tokio::test]
async fn late_inflight_failure_cannot_shadow_existing_cooldown_recovery_public_http() {
    run_v31_recovery_case("503-late-probe", 503, 3, true).await;
}

#[tokio::test]
async fn zen_non_2xx_unfinished_probe_body_preserves_cooldown_and_allows_fallback() {
    run_v31_recovery_case("503-failed-probe", 503, 3, true).await;
}

#[tokio::test]
async fn business_5xx_observation_automatically_probes_and_restores_exact_key() {
    run_v31_recovery_case("503-recovery", 503, 3, false).await;
}
