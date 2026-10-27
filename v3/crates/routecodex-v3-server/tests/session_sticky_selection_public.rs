//! Real public-entry sticky provider selection regression.
//!
//! One sticky pool with two Responses providers of equal priority and weight.
//! A client `x-session-id` header pins the session: the same session must keep
//! serving from one provider across requests, and two different sessions must
//! spread over the pool instead of stacking on the same provider.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

struct Upstream {
    calls: Arc<AtomicUsize>,
    fail: AtomicBool,
    label: &'static str,
}

async fn upstream(State(state): State<Arc<Upstream>>, _json: Json<Value>) -> Response<Body> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    if state.fail.load(Ordering::SeqCst) {
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Body::from("unavailable"))
            .unwrap();
    }
    let body = json!({
        "id": "resp-test",
        "object": "response",
        "status": "completed",
        "model": state.label,
        "output": [{ "id": "msg", "type": "message", "role": "assistant", "status": "completed",
            "content": [{ "type": "output_text", "text": state.label, "annotations": [] }] }],
        "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

async fn peer(label: &'static str) -> (u16, Arc<Upstream>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Upstream {
        calls: Arc::new(AtomicUsize::new(0)),
        fail: AtomicBool::new(false),
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
    tasks: Vec<tokio::task::JoinHandle<()>>,
    a: Arc<Upstream>,
    b: Arc<Upstream>,
}

impl Entry {
    async fn start() -> Self {
        Self::start_with_options(false, false).await
    }

    async fn start_with_isolated_pools(isolated: bool) -> Self {
        Self::start_with_options(isolated, false).await
    }

    async fn start_with_options(isolated: bool, tiered: bool) -> Self {
        let (a_port, a, a_task) = peer("provider-a").await;
        let (b_port, b, b_task) = peer("provider-b").await;
        std::env::set_var("STICKY_KEY", "sticky-test-key");
        let port = test_ports::free_port();
        let source = format!(
            r#"
version = 3
{declaration}
[servers.sticky_pool]
bind = "127.0.0.1"
port = {port}
routing_group = "sticky_pool"
endpoints = ["responses"]
{execution}
[providers.a]
type = "responses"
base_url = "http://127.0.0.1:{a_port}/v1"
default_model = "wire-a"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "STICKY_KEY" }}] }}
[providers.a.models.wire-a]
wire_name = "wire-a"
capabilities = ["text", "tools"]
[providers.b]
type = "responses"
base_url = "http://127.0.0.1:{b_port}/v1"
default_model = "wire-b"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "STICKY_KEY" }}] }}
[providers.b.models.wire-b]
wire_name = "wire-b"
capabilities = ["text", "tools"]
[route_groups.sticky_pool.pools.default]
selection = {{ strategy = "sticky" }}
targets = [
  {{ kind = "provider_model", provider = "a", model = "wire-a", key = "key", priority = 1, weight = 1 }},
  {{ kind = "provider_model", provider = "b", model = "wire-b", key = "key", priority = 1, weight = 1 }}
]
"#,
            declaration = hub_v1_fixture::hub_v1_test_declaration(),
            execution = hub_v1_fixture::hub_v1_server_execution("sticky_pool"),
        );
        let mut manifest =
            compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
        if tiered {
            manifest
                .route_groups
                .get_mut("sticky_pool")
                .unwrap()
                .pools
                .get_mut("default")
                .unwrap()
                .targets[0]
                .priority = Some(2);
        }
        if isolated {
            for provider in manifest.providers.values_mut() {
                for model in provider.models.values_mut() {
                    model.capabilities.push("multimodal".into());
                }
            }
            let group = manifest.route_groups.get_mut("sticky_pool").unwrap();
            let default = group.pools.get_mut("default").unwrap();
            let b = default.targets.pop().unwrap();
            let mut thinking = default.clone();
            thinking.id = "thinking".into();
            thinking.targets = vec![b];
            thinking.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
                precedence: 1,
                entry_protocol: None,
                models: Vec::new(),
                required_capabilities: vec!["thinking".into()],
                min_input_tokens: None,
                max_input_tokens: None,
            });
            group.pools.insert("thinking".into(), thinking);
            let mut multimodal = group.pools["default"].clone();
            multimodal.id = "multimodal".into();
            multimodal.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchManifest {
                precedence: 0,
                entry_protocol: None,
                models: Vec::new(),
                required_capabilities: vec!["multimodal".into()],
                min_input_tokens: None,
                max_input_tokens: None,
            });
            group.pools.insert("multimodal".into(), multimodal);
        }
        let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
        Self {
            base: format!("http://{}", handle.listeners[0].addr),
            handle,
            tasks: vec![a_task, b_task],
            a,
            b,
        }
    }

    async fn request(&self, session_id: &str) -> String {
        self.request_input(session_id, json!("controlled request"))
            .await
    }

    async fn request_input(&self, session_id: &str, input: Value) -> String {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
            .post(format!("{}/v1/responses", self.base))
            .header("x-session-id", session_id)
            .json(&json!({"model": "client", "input": input}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    }

    fn served_provider(&self, body: &str) -> &'static str {
        let parsed: Value = serde_json::from_str(body).expect("responses body must be JSON");
        match parsed["model"].as_str() {
            Some("provider-a") => "provider-a",
            Some("provider-b") => "provider-b",
            other => panic!("unexpected provider model in response: {other:?}"),
        }
    }

    async fn stop(self) {
        self.handle.shutdown().await;
        for task in self.tasks {
            task.abort();
            let _ = task.await;
        }
    }
}

#[tokio::test]
async fn session_sticky_binding_stays_inside_selected_pool() {
    let _home = LOCK.lock().await;
    let entry = Entry::start_with_isolated_pools(true).await;
    let image_input = json!([{"role":"user","content":[{"type":"input_text","text":"describe"},{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo="}]}]);
    let multimodal = entry
        .request_input("isolated-session", image_input.clone())
        .await;
    assert_eq!(entry.served_provider(&multimodal), "provider-a");
    let thinking = entry.request("isolated-session").await;
    assert_eq!(entry.served_provider(&thinking), "provider-b");
    let again = entry.request_input("isolated-session", image_input).await;
    assert_eq!(entry.served_provider(&again), "provider-a");
    entry.stop().await;
}

#[tokio::test]
async fn same_session_uses_standby_when_primary_fails() {
    let _home = LOCK.lock().await;
    let entry = Entry::start_with_options(false, true).await;
    let primary = entry.served_provider(&entry.request("failover-session").await);
    assert_eq!(
        primary, "provider-a",
        "higher tier must win before failover"
    );
    let failed = if primary == "provider-a" {
        &entry.a
    } else {
        &entry.b
    };
    let standby = if primary == "provider-a" {
        "provider-b"
    } else {
        "provider-a"
    };
    failed.fail.store(true, Ordering::SeqCst);
    let response = entry.request("failover-session").await;
    assert_eq!(entry.served_provider(&response), standby);
    assert!(
        failed.calls.load(Ordering::SeqCst) >= 2,
        "the primary must actually fail before standby serves"
    );
    let next = entry.request("failover-session").await;
    assert_eq!(entry.served_provider(&next), standby);
    entry.stop().await;
}

#[tokio::test]
async fn same_session_stays_and_different_sessions_spread() {
    let _home = LOCK.lock().await;
    let entry = Entry::start().await;

    let first = entry.request("session-one").await;
    let first_provider = entry.served_provider(&first);
    let second = entry.request("session-one").await;
    assert_eq!(
        entry.served_provider(&second),
        first_provider,
        "the same session must keep its provider across requests"
    );

    let other_session = entry.request("session-two").await;
    assert_ne!(
        entry.served_provider(&other_session),
        first_provider,
        "a different session must spread to the pool's other member"
    );

    // Both requests in one session and the one in the other must each land on
    // exactly one provider, so the two-member pool is exercised end to end.
    entry.stop().await;
}

#[tokio::test]
async fn no_session_header_keeps_working_without_sticky_binding() {
    let _home = LOCK.lock().await;
    let entry = Entry::start().await;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let body = client
        .post(format!("{}/v1/responses", entry.base))
        .json(&json!({"model": "client", "input": "controlled request"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        body.status(),
        StatusCode::OK,
        "a request without a session header must still complete"
    );
    let text = body.text().await.unwrap();
    let provider = entry.served_provider(&text);
    assert!(
        provider == "provider-a" || provider == "provider-b",
        "an ordinary request must still route to a pool member: {provider}"
    );
    entry.stop().await;
}
