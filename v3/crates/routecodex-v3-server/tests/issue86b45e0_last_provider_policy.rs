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

const FINAL_PROVIDER_ERROR_BODY: &str = r#"{"error":{"message":"controlled provider failure"}}"#;

struct Upstream {
    calls: AtomicUsize,
    fail: bool,
    label: &'static str,
}
async fn upstream(State(s): State<Arc<Upstream>>, Json(body): Json<Value>) -> Response<Body> {
    // Count actual business requests so synthetic traffic cannot satisfy this test.
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

#[derive(Debug)]
struct ClientResponse {
    status: reqwest::StatusCode,
    body: String,
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
    async fn request_response(&self, stream: bool) -> Result<ClientResponse, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let response = client
            .post(format!("{}/v1/responses", self.base))
            .json(&json!({"model":"client","input":"controlled request","stream":stream}))
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        Ok(ClientResponse { status, body })
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
    async fn relay_response(&self) -> Result<ClientResponse, reqwest::Error> {
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
            .post(format!("{}/v1/messages", self.base))
            .json(&json!({"model":"client","max_tokens":100,"messages":[{"role":"user","content":"controlled request"}]}))
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        Ok(ClientResponse { status, body })
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
    // A legacy broad probe restriction is not an exact business-recovery episode.
    // Keep its singleton exemption separate from an active exact manual hold.
    let added = reqwest::Client::new()
        .post(format!(
            "{}/_routecodex/health/cooldown-pool/add",
            entry.base
        ))
        .json(
            &json!({"provider_id":"a","interface_id":"default","kind":"probe","duration_ms":60000}),
        )
        .send()
        .await
        .unwrap();
    assert!(added.status().is_success());
    let one = entry.request_response(true).await;
    let first = entry.a.calls.load(Ordering::SeqCst);
    let two = entry.request_response(true).await;
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
    for reply in [one, two] {
        assert!(
            reply.is_err(),
            "final Provider HTTP 503 must break transport without reaching the client: {reply:?}"
        );
    }
}

#[tokio::test]
async fn i86_single_active_exact_cooldown_requires_release() {
    let _home = LOCK.lock().await;
    let entry = Entry::start(false).await;
    let client = reqwest::Client::new();
    let identity = json!({"provider_id":"a","interface_id":"default","auth_alias":"key","model_id":"wire-a","kind":"probe"});
    let mut addition = identity.clone();
    addition["duration_ms"] = json!(60000);
    let added = client
        .post(format!(
            "{}/_routecodex/health/cooldown-pool/add",
            entry.base
        ))
        .json(&addition)
        .send()
        .await
        .unwrap();
    assert!(added.status().is_success());
    let before = entry.cooldown().await;
    for stream in [false, true] {
        assert!(
            entry.request_response(stream).await.is_err(),
            "an active exact hold must break transport without a fabricated response"
        );
    }
    let held_calls = entry.a.calls.load(Ordering::SeqCst);
    let after = entry.cooldown().await;
    let removed = client
        .post(format!("{}/_routecodex/health/cooldown-pool", entry.base))
        .json(&identity)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::OK);
    let removed: Value = removed.json().await.unwrap();
    assert_eq!(removed["removed"], true);
    let reply = entry.request_response(false).await;
    let calls = entry.a.calls.load(Ordering::SeqCst);
    let released_pool = entry.cooldown().await;
    entry.stop().await;
    assert_eq!(
        held_calls, 0,
        "singleton status cannot bypass an active exact hold"
    );
    assert_eq!(before["entries"].as_array().unwrap().len(), 1);
    assert_eq!(after["entries"].as_array().unwrap().len(), 1);
    assert_eq!(
        before["entries"][0]["until_ms"],
        after["entries"][0]["until_ms"]
    );
    assert_eq!(
        calls, 1,
        "operator release must restore the next real request"
    );
    reply.expect_err(
        "the final real Provider HTTP 503 must break transport without reaching the client",
    );
    assert!(
        released_pool["entries"].as_array().unwrap().is_empty(),
        "the final candidate failure must remain health-neutral: {released_pool}"
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
        replies.push(entry.request_response(true).await);
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
    for reply in replies {
        reply.expect_err(
            "the final real Provider HTTP 503 must break transport without reaching the client",
        );
    }
}

#[tokio::test]
async fn i86_multi_last_eligible_stays_routable() {
    let _home = LOCK.lock().await;
    let entry = Entry::start_with_b_failure(true, true).await;
    let added = reqwest::Client::new().post(format!("{}/_routecodex/health/cooldown-pool/add",entry.base)).json(&json!({"provider_id":"a","interface_id":"default","auth_alias":"key","model_id":"wire-a","kind":"probe","duration_ms":60000})).send().await.unwrap();
    assert!(added.status().is_success());
    let one = entry.request_response(true).await;
    let two = entry.request_response(true).await;
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
    let one = one.expect_err(
        "the final real Provider HTTP 503 must break transport without reaching the client",
    );
    let two = two.expect_err(
        "the final real Provider HTTP 503 must break transport without reaching the client",
    );
    let _ = (one, two);
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
        let (failed, healthy) = tokio::join!(
            entry.request_response(stream),
            sibling.request_stream(stream)
        );
        let calls = (
            entry.a.calls.load(Ordering::SeqCst),
            entry.b.calls.load(Ordering::SeqCst),
        );
        let pool = entry.cooldown().await;
        entry.stop().await;
        sibling.stop().await;
        assert_eq!(calls, (1, 1), "each failed candidate is sent once");
        failed.expect_err(
            "the final real Provider HTTP 503 must break transport without reaching the client",
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
    let one = single.relay_response().await;
    let two = single.relay_response().await;
    let calls = single.a.calls.load(Ordering::SeqCst);
    let pool = single.cooldown().await;
    single.stop().await;
    assert_eq!(
        calls, 2,
        "Relay must send each new request once without terminal retry"
    );
    let one = one.expect_err(
        "the final real Anthropic Relay HTTP 503 must break transport without reaching the client",
    );
    let two = two.expect_err(
        "the final real Anthropic Relay HTTP 503 must break transport without reaching the client",
    );
    let _ = (one, two);
    assert!(
        pool["entries"].as_array().unwrap().is_empty(),
        "Relay last candidate cannot cool: {pool}"
    );
}
