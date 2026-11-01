//! Real public-entry last-provider policy regressions. No production endpoints.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

struct Upstream {
    calls: AtomicUsize,
    fail: bool,
    label: &'static str,
}
async fn upstream(State(s): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    // Existing recovery events may still probe a preloaded cooldown. Count
    // actual business requests separately so a ping cannot satisfy this test.
    if body.to_string().contains("controlled request") {
        s.calls.fetch_add(1, Ordering::SeqCst);
    }
    let (status, body) = if s.fail {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error":{"message":"controlled provider failure"}}),
        )
    } else {
        (
            StatusCode::OK,
            json!({"id":"resp-test","object":"response","status":"completed","model":"wire-b","output":[{"id":"msg-test","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":s.label,"annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}),
        )
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}
async fn peer(
    fail: bool,
    label: &'static str,
) -> (u16, Arc<Upstream>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Upstream {
        calls: AtomicUsize::new(0),
        fail,
        label,
    });
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (port, state, task)
}
struct Entry {
    base: String,
    handle: V3ServerAggregateHandle,
    a: Arc<Upstream>,
    b: Arc<Upstream>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Entry {
    async fn start(two: bool) -> Self {
        Self::start_with_b_failure(two, false).await
    }
    async fn start_with_b_failure(two: bool, b_fail: bool) -> Self {
        let (a_port, a, a_task) = peer(true, "A").await;
        let (b_port, b, b_task) = peer(b_fail, "BUSINESS_B").await;
        std::env::set_var("I86_KEY", "isolated-test-key");
        let b_config = if two {
            format!(
                r#"
[providers.b]
type = "responses"
base_url = "http://127.0.0.1:{b_port}/v1"
default_model = "wire-b"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "I86_KEY" }}] }}
[providers.b.models.wire-b]
wire_name = "wire-b"
capabilities = ["text", "tools"]
"#
            )
        } else {
            String::new()
        };
        let targets = if two {
            r#"[{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 10 }, { kind = "provider_model", provider = "b", model = "wire-b", key = "key", priority = 1 }]"#
        } else {
            r#"[{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 10 }]"#
        };
        let port = test_ports::free_port();
        let source = format!(
            r#"
version = 3
{declaration}
[servers.policy]
bind = "127.0.0.1"
port = {port}
routing_group = "policy"
endpoints = ["responses", "anthropic"]
{execution}
[providers.a]
type = "responses"
base_url = "http://127.0.0.1:{a_port}/v1"
default_model = "wire-a"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "I86_KEY" }}] }}
[providers.a.models.wire-a]
wire_name = "wire-a"
capabilities = ["text", "tools"]
{b_config}
[route_groups.policy.pools.default]
selection = {{ strategy = "priority" }}
targets = {targets}
"#,
            declaration = hub_v1_fixture::hub_v1_test_declaration(),
            execution = hub_v1_fixture::hub_v1_server_execution("policy")
        );
        let manifest =
            compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
        let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
        Self {
            base: format!("http://{}", handle.listeners[0].addr),
            handle,
            a,
            b,
            tasks: vec![a_task, b_task],
        }
    }
    async fn request(&self) -> Result<String, reqwest::Error> {
        self.request_stream(true).await
    }
    async fn request_stream(&self, stream: bool) -> Result<String, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        client
            .post(format!("{}/v1/responses", self.base))
            .json(&json!({"model":"client","input":"controlled request","stream":stream}))
            .send()
            .await?
            .text()
            .await
    }
    async fn cooldown(&self) -> Value {
        reqwest::get(format!("{}/_routecodex/health/cooldown-pool", self.base))
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn relay_request(&self) -> Result<String, reqwest::Error> {
        reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap()
            .post(format!("{}/v1/messages", self.base))
            .json(&json!({"model":"client","max_tokens":100,"messages":[{"role":"user","content":"controlled request"}]}))
            .send().await?.text().await
    }
    async fn stop(self) {
        self.handle.shutdown().await;
        for t in self.tasks {
            t.abort();
            let _ = t.await;
        }
    }
}

#[tokio::test]
async fn i86_single_stale_cooldown_bypass() {
    let _home = LOCK.lock().await;
    let entry = Entry::start(false).await;
    let added = reqwest::Client::new().post(format!("{}/_routecodex/health/cooldown-pool/add",entry.base)).json(&json!({"provider_id":"a","interface_id":"default","auth_alias":"key","model_id":"wire-a","kind":"probe","duration_ms":60000})).send().await.unwrap();
    assert!(added.status().is_success());
    let _ = entry.request().await;
    let first = entry.a.calls.load(Ordering::SeqCst);
    let _ = entry.request().await;
    let second = entry.a.calls.load(Ordering::SeqCst);
    entry.stop().await;
    assert_eq!(
        first, 1,
        "single candidate's old automatic cooldown must not block real business send"
    );
    assert_eq!(
        second, 2,
        "a new request must send again without retrying the failed request"
    );
}

#[tokio::test]
async fn i86_multi_next_candidate_success() {
    let _home = LOCK.lock().await;
    let entry = Entry::start(true).await;
    let reply = entry.request().await;
    let calls = (
        entry.a.calls.load(Ordering::SeqCst),
        entry.b.calls.load(Ordering::SeqCst),
    );
    entry.stop().await;
    assert_eq!(calls, (1, 1), "finite switching must visit A then B once");
    assert!(reply.unwrap().contains("BUSINESS_B"));
}

#[tokio::test]
async fn i86_last_eligible_failure_is_terminal() {
    let _home = LOCK.lock().await;
    let entry = Entry::start(false).await;
    let mut replies = Vec::new();
    for _ in 0..3 {
        replies.push(entry.request().await);
    }
    let calls = entry.a.calls.load(Ordering::SeqCst);
    let pool = entry.cooldown().await;
    entry.stop().await;
    assert_eq!(
        calls, 3,
        "each new request sends once; no automatic retries or health exclusion"
    );
    assert!(
        pool["entries"].as_array().unwrap().is_empty(),
        "last candidate must not acquire cooldown: {pool}"
    );
    assert!(
        replies.iter().all(Result::is_err),
        "failed attempt must terminate transport, never return normal empty success"
    );
}

#[tokio::test]
async fn i86_multi_last_eligible_stays_routable() {
    let _home = LOCK.lock().await;
    let entry = Entry::start_with_b_failure(true, true).await;
    let added = reqwest::Client::new().post(format!("{}/_routecodex/health/cooldown-pool/add",entry.base)).json(&json!({"provider_id":"a","interface_id":"default","auth_alias":"key","model_id":"wire-a","kind":"probe","duration_ms":60000})).send().await.unwrap();
    assert!(added.status().is_success());
    let one = entry.request().await;
    let two = entry.request().await;
    let calls = (
        entry.a.calls.load(Ordering::SeqCst),
        entry.b.calls.load(Ordering::SeqCst),
    );
    let pool = entry.cooldown().await;
    entry.stop().await;
    assert_eq!(
        calls,
        (0, 2),
        "last eligible B must remain usable on the next request without retrying A"
    );
    assert!(one.is_err() && two.is_err());
    assert!(
        pool["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["provider_id"] != "b"),
        "B failure cannot create cooldown: {pool}"
    );
}

#[tokio::test]
async fn i86_exhaustion_is_request_local() {
    let _home = LOCK.lock().await;
    for stream in [false, true] {
        let entry = Entry::start_with_b_failure(true, true).await;
        let sibling = Entry::start(true).await;
        let (failed, healthy) =
            tokio::join!(entry.request_stream(stream), sibling.request_stream(stream));
        let calls = (
            entry.a.calls.load(Ordering::SeqCst),
            entry.b.calls.load(Ordering::SeqCst),
        );
        let pool = entry.cooldown().await;
        entry.stop().await;
        sibling.stop().await;
        assert_eq!(calls, (1, 1), "each failed candidate is sent once");
        assert!(
            failed.is_err(),
            "JSON/SSE exhaustion must be detectable transport termination"
        );
        assert!(
            healthy.unwrap().contains("BUSINESS_B"),
            "failure must not terminate an independent request"
        );
        assert!(
            pool["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["provider_id"] != "b"),
            "final B must stay out of cooldown: {pool}"
        );
    }
}

#[tokio::test]
async fn i86_relay_switch_and_last_terminal() {
    let _home = LOCK.lock().await;
    let recovering = Entry::start(true).await;
    let reply = recovering.relay_request().await;
    let calls = (
        recovering.a.calls.load(Ordering::SeqCst),
        recovering.b.calls.load(Ordering::SeqCst),
    );
    recovering.stop().await;
    assert_eq!(calls, (1, 1));
    assert!(reply.unwrap().contains("BUSINESS_B"));

    let single = Entry::start(false).await;
    let one = single.relay_request().await;
    let two = single.relay_request().await;
    let calls = single.a.calls.load(Ordering::SeqCst);
    let pool = single.cooldown().await;
    single.stop().await;
    assert_eq!(
        calls, 2,
        "Relay must send each new request once without terminal retry"
    );
    assert!(one.is_err() && two.is_err());
    assert!(
        pool["entries"].as_array().unwrap().is_empty(),
        "Relay last candidate cannot cool: {pool}"
    );
}
