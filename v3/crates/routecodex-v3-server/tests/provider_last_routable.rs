//! Public-entry recovery: a failed identity must not drain the last usable route.
use axum::{body::Body, extract::State, response::Response, routing::post, Json, Router};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, Mutex};
#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

struct Peer {
    direct: bool,
    truncate: bool,
    first: Mutex<Vec<Instant>>,
    last: Mutex<Vec<(Instant, Value)>>,
}

fn has_tools(body: &Value) -> bool {
    body["tools"]
        .as_array()
        .is_some_and(|tools| !tools.is_empty())
}

async fn first(State(peer): State<Arc<Peer>>, Json(body): Json<Value>) -> Response<Body> {
    if !has_tools(&body) {
        return Response::new(Body::from("{}"));
    }
    peer.first.lock().await.push(Instant::now());
    Response::builder()
        .status(401)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"error":{"type":"authentication_error","message":"fixture first key rejected"}}"#,
        ))
        .unwrap()
}

fn event(kind: &str, value: Value) -> String {
    format!("event: {kind}\ndata: {value}\n\n\n")
}

async fn last(State(peer): State<Arc<Peer>>, Json(body): Json<Value>) -> Response<Body> {
    if !has_tools(&body) {
        return Response::new(Body::from("{}"));
    }
    let attempt = {
        let mut calls = peer.last.lock().await;
        calls.push((Instant::now(), body.clone()));
        calls.len()
    };
    let followup = if peer.direct {
        body["input"]
            .as_array()
            .is_some_and(|items| items.iter().any(|i| i["type"] == "function_call_output"))
    } else {
        body["messages"].as_array().is_some_and(|items| {
            items.iter().any(|i| {
                i["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"))
            })
        })
    };
    if followup {
        let wire = body.to_string();
        assert!(
            wire.contains("call_last") && wire.contains("42"),
            "paired actual tool result missing"
        );
    }
    let wire = if peer.direct {
        let start = event(
            "response.created",
            json!({"type":"response.created","response":{
            "id":"resp_last","object":"response","status":"in_progress","output":[]}}),
        );
        if peer.truncate && attempt == 1 {
            start
                + &event(
                    "response.output_text.delta",
                    json!({"type":"response.output_text.delta",
                "item_id":"partial_item","output_index":0,"content_index":0,"delta":"WITHDRAW_PARTIAL_ATTEMPT"}),
                )
        } else {
            let output = if followup {
                json!([{"type":"message","id":"msg_last","role":"assistant","status":"completed",
                    "content":[{"type":"output_text","text":"42","annotations":[]}]}])
            } else {
                json!([{"type":"function_call","id":"fc_last","call_id":"call_last","name":"diagnostic_add",
                    "arguments":"{\"a\":17,\"b\":25}","status":"completed"}])
            };
            start
                + &event(
                    "response.completed",
                    json!({"type":"response.completed","response":{
                "id":"resp_last","object":"response","model":"fixture","status":"completed","output":output,
                "usage":{"input_tokens":4,"output_tokens":8,"total_tokens":12}}}),
                )
        }
    } else {
        let start = event(
            "message_start",
            json!({"type":"message_start","message":{
            "id":"msg_last","type":"message","role":"assistant","model":"fixture","content":[],
            "stop_reason":null,"usage":{"input_tokens":4,"output_tokens":0}}}),
        );
        if peer.truncate && attempt == 1 {
            start
                + &event(
                    "content_block_start",
                    json!({"type":"content_block_start","index":0,
                "content_block":{"type":"text","text":"WITHDRAW_PARTIAL_ATTEMPT"}}),
                )
        } else {
            let block = if followup {
                json!({"type":"text","text":"42"})
            } else {
                json!({"type":"tool_use","id":"call_last","name":"diagnostic_add","input":{"a":17,"b":25}})
            };
            start
                + &event(
                    "content_block_start",
                    json!({"type":"content_block_start","index":0,"content_block":block}),
                )
                + &event(
                    "content_block_stop",
                    json!({"type":"content_block_stop","index":0}),
                )
                + &event(
                    "message_delta",
                    json!({"type":"message_delta","delta":{"stop_reason":if followup {"end_turn"} else {"tool_use"}},"usage":{"output_tokens":8}}),
                )
                + &event("message_stop", json!({"type":"message_stop"}))
        }
    };
    let chunks: Vec<Result<Vec<u8>, std::convert::Infallible>> =
        wire.as_bytes().chunks(17).map(|c| Ok(c.to_vec())).collect();
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(futures_util::stream::iter(chunks)))
        .unwrap()
}

fn completed(raw: &str) -> Value {
    assert!(
        !raw.contains("event: error"),
        "provider error must remain internal: {raw}"
    );
    raw.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|v| v["type"] == "response.completed")
        .expect("business completion required")["response"]
        .clone()
}

async fn exercise(direct: bool, truncate: bool) {
    exercise_budget(direct, truncate, 5, 10000).await;
}

async fn exercise_budget(direct: bool, truncate: bool, max_attempts: usize, residence_ms: u64) {
    let id = format!(
        "recovery_{}_{}_{}_{}",
        direct, truncate, max_attempts, residence_ms
    );
    let peer = Arc::new(Peer {
        direct,
        truncate,
        first: Mutex::new(Vec::new()),
        last: Mutex::new(Vec::new()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown, wait) = oneshot::channel();
    let app = Router::new()
        .route("/first/v1/messages", post(first))
        .route("/last/v1/messages", post(last))
        .route("/first/v1/responses", post(first))
        .route("/last/v1/responses", post(last))
        .with_state(peer.clone());
    let upstream = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = wait.await;
            })
            .await
            .unwrap();
    });
    let locator = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = locator.local_addr().unwrap().port();
    drop(locator);
    let locator = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let sole_port = locator.local_addr().unwrap().port();
    drop(locator);
    let sole = format!("sole_{id}");
    let protocol = if direct { "responses" } else { "anthropic" };
    let suffix = if direct { "/v1" } else { "" };
    let source = format!(
        r#"
version = 3
{}
[servers.{id}]
bind = "127.0.0.1"
port = {port}
routing_group = "{id}"
endpoints = ["responses"]
{}
[servers.{id}.execution.attempt_store]
request_max_attempts = {max_attempts}
attempt_max_bytes = 1048576
attempt_max_frames = 1024
request_max_bytes = 5242880
process_max_bytes = 16777216
residence_timeout_ms = {residence_ms}
[providers.first_{id}]
type = "{protocol}"
base_url = "http://{address}/first{suffix}"
default_model = "fixture"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "LAST_ROUTABLE_FIXTURE_KEY" }}] }}
[providers.first_{id}.models.fixture]
wire_name = "fixture"
capabilities = ["text", "tools"]
[providers.last_{id}]
type = "{protocol}"
base_url = "http://{address}/last{suffix}"
default_model = "fixture"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "LAST_ROUTABLE_FIXTURE_KEY" }}] }}
[providers.last_{id}.models.fixture]
wire_name = "fixture"
capabilities = ["text", "tools"]
[route_groups.{id}.pools.default]
targets = [
 {{ kind = "provider_model", provider = "first_{id}", model = "fixture", key = "key", priority = 2 }},
 {{ kind = "provider_model", provider = "last_{id}", model = "fixture", key = "key", priority = 1 }}
]
[servers.{sole}]
bind = "127.0.0.1"
port = {sole_port}
routing_group = "{sole}"
endpoints = ["responses"]
{}
[servers.{sole}.execution.attempt_store]
request_max_attempts = 2
residence_timeout_ms = 10000
[route_groups.{sole}.pools.default]
targets = [{{ kind = "provider_model", provider = "first_{id}", model = "fixture", key = "key", priority = 1 }}]
"#,
        fixture::hub_v1_test_declaration(),
        fixture::hub_v1_server_execution(&id),
        fixture::hub_v1_server_execution(&sole)
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let addr = server.listeners.iter().find(|listener| listener.server_id == id).unwrap().addr;
    let url = format!("http://{addr}/v1/responses");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap();
    let tools = json!([{"type":"function","name":"diagnostic_add","description":"Add integers","parameters":{
        "type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"]}}]);
    let user = json!({"role":"user","content":"Add17and25 with diagnostic_add"});
    let request_started = Instant::now();
    let raw = client
        .post(&url)
        .header("session_id", "first-session")
        .json(&json!({"model":"router",
        "input":[user.clone()],"tools":tools,"stream":true}))
        .send()
        .await
        .unwrap()
        .text()
        .await;
    if max_attempts < 3 || residence_ms < 1000 {
        assert!(
            request_started.elapsed() < Duration::from_millis(800),
            "exhausted request must not enter an impossible wait"
        );
        assert!(raw.is_err(), "exhaustion must end transport detectably, never as empty success");
        if let Ok(raw) = raw {
            assert!(
                !raw.contains("response.completed")
                    && !raw.contains("event: error")
                    && !raw.contains("WITHDRAW_PARTIAL_ATTEMPT"),
                "exhaustion must terminate transport without semantic output: {raw}"
            );
        }
        assert_eq!(peer.first.lock().await.len(), 1);
        assert_eq!(peer.last.lock().await.len(), usize::from(max_attempts > 1));
        if max_attempts == 2 {
            let next_started = Instant::now();
            let next = client
                .post(&url)
                .header("session_id", "another-session-after-exhaustion")
                .json(&json!({"model":"router","input":[user],"tools":tools,"stream":true}))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(
                next_started.elapsed() >= Duration::from_millis(900),
                "new session bypassed failed identity backoff"
            );
            assert!(completed(&next)["output"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["type"] == "function_call"));
            assert_eq!(peer.first.lock().await.len(), 1);
            assert_eq!(peer.last.lock().await.len(), 2);
        }
        if residence_ms < 1000 {
            let waiting_started = Instant::now();
            let waiting = client
                .post(&url)
                .header("session_id", "deadline-while-existing-backoff")
                .json(&json!({"model":"router","input":[user],"tools":tools,"stream":true}))
                .send()
                .await
                .unwrap()
                .text()
                .await;
            assert!(
                waiting.is_err(),
                "deadline must terminate the transport detectably"
            );
            assert!(
                waiting_started.elapsed() >= Duration::from_millis(200)
                    && waiting_started.elapsed() < Duration::from_millis(800),
                "existing gate must respect the new request deadline"
            );
            assert_eq!(
                peer.last.lock().await.len(),
                1,
                "expired waiter must not send to provider"
            );
            let health = url.replace("/v1/responses", "/health");
            assert_eq!(client.get(health).send().await.unwrap().status(), 200);
        }
        assert!(server.shutdown().await.is_empty());
        let _ = shutdown.send(());
        upstream.await.unwrap();
        return;
    }
    let raw = raw.expect("candidate recovery must preserve client transport");
    assert!(
        !raw.contains("WITHDRAW_PARTIAL_ATTEMPT"),
        "failed attempt leaked to client"
    );
    let response = completed(&raw);
    let call = response["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "function_call")
        .unwrap()
        .clone();
    let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    let sum = args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap();
    assert_eq!(sum, 42);
    let next = client.post(&url).header("session_id", "second-session").json(&json!({"model":"router",
        "input":[user,call.clone(),{"type":"function_call_output","call_id":call["call_id"],"output":sum.to_string()}],
        "tools":tools,"stream":true})).send().await.unwrap().text().await.unwrap();
    assert!(completed(&next)["output"].to_string().contains("42"));
    let first_calls = peer.first.lock().await;
    let last_calls = peer.last.lock().await;
    assert_eq!(first_calls.len(), 1, "already cooled peer must stay cooled");
    assert!(
        last_calls[0].0.duration_since(first_calls[0]) < Duration::from_millis(800),
        "healthy alternative must not await failed identity"
    );
    assert_eq!(last_calls.len(), if truncate { 3 } else { 2 });
    if truncate {
        assert!(
            last_calls[1].0.duration_since(last_calls[0].0) >= Duration::from_millis(900),
            "last identity must wait before resend"
        );
        assert_eq!(
            last_calls[0].1, last_calls[1].1,
            "retry must preserve the complete provider-bound request"
        );
    }
    drop(last_calls);
    drop(first_calls);
    // The multi-member listener cooled `first`; the other listener's sole
    // candidate must still be attempted, retried and remain outside cooldown.
    let sole_addr = server.listeners.iter().find(|listener| listener.server_id == sole).unwrap().addr;
    let before = Instant::now();
    let response = client.post(format!("http://{sole_addr}/v1/responses"))
        .header("session_id", "sole-other-port")
        .json(&json!({"model":"router","input":"use a tool","tools":[{"type":"function","name":"noop","parameters":{"type":"object"}}],"stream":true}))
        .send().await.unwrap().text().await;
    assert!(response.is_err(), "fixture rejects both sole attempts; transport must terminate");
    let calls = peer.first.lock().await;
    assert_eq!(calls.len(), 3, "other port cooldown cannot suppress sole candidate attempts");
    assert!(calls[1].duration_since(before) < Duration::from_millis(800), "other port gate cannot delay first send");
    assert!(calls[2].duration_since(calls[1]) >= Duration::from_millis(900), "sole failure must back off and resend");
    drop(calls);
    let preparation = tokio::time::timeout(Duration::from_secs(2), server.prepare_exec_attempt())
        .await.expect("both listener probe owners must quiesce").unwrap();
    drop(preparation);
    let resumed = client.post(&url).header("session_id", "after-two-port-probe-rollback")
        .json(&json!({"model":"router","input":"use a tool","tools":tools,"stream":true}))
        .send().await.unwrap().text().await.unwrap();
    completed(&resumed);
    for (address, should_be_cooled) in [(addr, true), (sole_addr, false)] {
        let health: Value = client.get(format!("http://{address}/_routecodex/health/cooldown-pool"))
            .send().await.unwrap().json().await.unwrap();
        let cooled = health["entries"].as_array().unwrap().iter()
            .any(|entry| entry["provider_id"] == format!("first_{id}"));
        assert_eq!(cooled, should_be_cooled, "cooldown visibility must belong to its listener: {health}");
    }
    assert!(server.shutdown().await.is_empty());
    let _ = shutdown.send(());
    upstream.await.unwrap();
}

#[tokio::test]
async fn last_routable_direct_and_relay_preserve_tools_and_do_not_block_alternatives() {
    let (_home, _guard) = LOCK.lock().await;
    std::env::set_var("LAST_ROUTABLE_FIXTURE_KEY", "fixture-key");
    for direct in [false, true] {
        exercise(direct, false).await;
        exercise(direct, true).await;
        exercise_budget(direct, true, 2, 10000).await;
        exercise_budget(direct, true, 5, 250).await;
    }
    std::env::remove_var("LAST_ROUTABLE_FIXTURE_KEY");
}
