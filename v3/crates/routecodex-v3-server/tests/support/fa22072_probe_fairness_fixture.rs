use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, Semaphore},
    task::JoinHandle,
};

#[path = "../../../routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

pub struct Peer {
    pub captures: Mutex<Vec<Value>>,
    pub holders_entered: Semaphore,
    pub holders_release: Semaphore,
    pub fifth_entered: Semaphore,
    pub fifth_release: Semaphore,
    pub ready: AtomicBool,
}

pub fn business(model: &str) -> Value {
    json!({"id":"fairness-complete", "object":"chat.completion", "model":model,
        "choices":[{"index":0,"message":{"role":"assistant","content":"complete fifth payload including tail", "tool_calls":[{"id":"paired-call","type":"function","function":{"name":"retain","arguments":"{\"tail\":true}"}}]},"finish_reason":"tool_calls"}],
        "usage":{"prompt_tokens":7,"completion_tokens":11,"total_tokens":18}})
}

async fn serve(
    State(peer): State<Arc<Peer>>,
    Path(index): Path<usize>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(headers["authorization"], "Bearer fairness-fixture-key");
    assert!(matches!(
        body["model"].as_str(),
        Some("recovery" | "sibling")
    ));
    let capture = json!({"index":index,"authorization":headers["authorization"].to_str().unwrap(),"body":body});
    eprintln!("fairness authenticated HTTP capture={capture}");
    peer.captures.lock().await.push(capture);
    let marker = body["messages"][0]["content"].as_str().unwrap();
    if marker == "genuine failure"
        || (marker == "ping; reply pong" && !peer.ready.load(Ordering::SeqCst))
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":{"message":"genuine fixture failure"}})),
        );
    }
    if marker == "holder" {
        assert!(index < 4);
        assert_eq!(body["model"], "sibling");
        peer.holders_entered.add_permits(1);
        peer.holders_release.acquire().await.unwrap().forget();
    }
    if marker == "ping; reply pong" {
        assert_eq!(body["model"], "recovery");
        if index == 4 {
            peer.fifth_entered.add_permits(1);
            peer.fifth_release.acquire().await.unwrap().forget();
        }
        return (StatusCode::OK, Json(json!({"actual":"2xx probe success"})));
    }
    (
        StatusCode::OK,
        Json(business(body["model"].as_str().unwrap())),
    )
}

pub async fn peer() -> (Arc<Peer>, String, JoinHandle<()>) {
    let peer = Arc::new(Peer {
        captures: Mutex::new(Vec::new()),
        holders_entered: Semaphore::new(0),
        holders_release: Semaphore::new(0),
        fifth_entered: Semaphore::new(0),
        fifth_release: Semaphore::new(0),
        ready: AtomicBool::new(false),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/:index/v1/chat/completions", post(serve))
        .with_state(peer.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (peer, base, task)
}

pub fn manifest(base: &str, port: u16) -> (V3Config05ManifestPublished, Vec<String>) {
    let ids: Vec<String> = (0..5)
        .map(|index| format!("fairness_{port}_{index}"))
        .collect();
    let mut source = format!("version = 3\n{}\n[servers.chat]\nbind = \"127.0.0.1\"\nport = {port}\nrouting_group = \"fairness\"\nendpoints = [\"openai_chat\"]\n{}\n[servers.chat.execution.attempt_store]\nrequest_max_attempts = 1\n[debug]\nlog_console = true\nsnapshots = false\ncodex_samples = false\n", hub_v1_fixture::hub_v1_test_declaration(), hub_v1_fixture::hub_v1_server_execution("chat"));
    for (index, id) in ids.iter().enumerate() {
        source.push_str(&format!(
            r#"
[providers.{id}]
type = "openai_chat"
base_url = "{base}/{index}/v1"
default_model = "recovery"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "FA22072_FAIRNESS_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
concurrency = {{ max_in_flight = 1, acquire_timeout_ms = 60000, stale_lease_ms = 120000 }}
[providers.{id}.models.recovery]
wire_name = "recovery"
capabilities = ["text", "tools"]
max_context_tokens = 1000000
[providers.{id}.models.sibling]
wire_name = "sibling"
capabilities = ["text", "tools"]
max_context_tokens = 1000000
"#
        ));
    }
    let targets = ids.iter().map(|id| format!(r#"{{ kind = "provider_model", provider = "{id}", model = "recovery", key = "key", priority = 1 }}"#)).collect::<Vec<_>>().join(",");
    source.push_str(&format!("\n[route_groups.fairness.pools.default]\nselection = {{ strategy = \"priority\" }}\ntargets = [{targets}]\n"));
    (
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap(),
        ids,
    )
}
