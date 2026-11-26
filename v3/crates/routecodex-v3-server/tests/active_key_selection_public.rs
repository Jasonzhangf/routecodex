//! Controlled public HTTP tests. Every provider result depends on the actual
//! auth alias and its scripted attempt, including the client tool-error round trip.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

#[path = "active_key_selection_public/review_regressions.rs"]
mod review_regressions;

#[path = "active_key_selection_public/business_recovery.rs"]
mod business_recovery;

#[path = "active_key_selection_public/final_boundaries.rs"]
mod final_boundaries;

// The filter lets CI expose Relay reds even while a Direct assertion fails.
fn paths() -> Vec<bool> {
    match std::env::var("ACTIVE_PUBLIC_PATH").as_deref() {
        Ok("relay") => vec![true],
        Ok("direct") => vec![false],
        _ => vec![false, true],
    }
}

#[derive(Clone, Copy, Debug)]
enum Outcome {
    Ok,
    Http(u16),
    SlowHttp(u16),
    Account(u16, &'static str),
    Truncated,
    InvalidJson,
    Empty,
    Slow,
    Refusal,
    ContentFilter,
    InvalidTool,
    GatedOk,
}
#[derive(Default)]
struct Script {
    next: BTreeMap<String, VecDeque<Outcome>>,
    calls: Vec<(String, Value)>,
}
struct Upstream {
    script: Mutex<Script>,
    chat: bool,
    protocol: &'static str,
}

async fn upstream(
    State(state): State<Arc<Upstream>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    let alias = headers
        .get("authorization")
        .or_else(|| headers.get("x-api-key"))
        .or_else(|| headers.get("x-goog-api-key"))
        .and_then(|h| h.to_str().ok())
        .and_then(|h| {
            h.strip_prefix("Bearer ")
                .unwrap_or(h)
                .strip_prefix("active-public-")
        })
        .expect("controlled alias credential must reach real provider wire")
        .to_owned();
    assert!(["A", "B", "C"].contains(&alias.as_str()));
    let outcome = {
        let mut script = state.script.lock().unwrap();
        script.calls.push((alias.clone(), body.clone()));
        script
            .next
            .get_mut(&alias)
            .and_then(VecDeque::pop_front)
            .unwrap_or(Outcome::Ok)
    };
    if matches!(outcome, Outcome::GatedOk) {
        business_recovery::wait_for_business_gate().await;
    }
    let http_status = match outcome {
        Outcome::Http(status) => Some(status),
        Outcome::SlowHttp(status) => {
            tokio::time::sleep(Duration::from_millis(200)).await;
            Some(status)
        }
        _ => None,
    };
    if let Some(status) = http_status {
        return Response::builder().status(status).header("content-type", "application/json")
            .body(Body::from(json!({"error":{"message":format!("ordinary controlled upstream failure alias={alias} status={status}"), "type":"server_error"}}).to_string())).unwrap();
    }
    if let Outcome::Account(status, code) = outcome {
        return Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":"controlled account failure", "type":code,"code":code}})
                    .to_string(),
            ))
            .unwrap();
    }
    if matches!(outcome, Outcome::Truncated) {
        let chunks = futures_util::stream::iter([
            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"{\"id\":\"partial")),
            Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "controlled final body truncation",
            )),
        ]);
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from_stream(chunks))
            .unwrap();
    }
    let tool = matches!(outcome, Outcome::InvalidTool);
    if matches!(outcome, Outcome::Slow) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if matches!(outcome, Outcome::InvalidJson) {
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from("{invalid-json"))
            .unwrap();
    }
    let result = if state.chat {
        json!({"id":"chat-active", "object":"chat.completion", "model":"wire", "choices":[{
            "index":0, "finish_reason":if tool {"tool_calls"} else {"stop"},
            "message":if tool {json!({"role":"assistant","tool_calls":[{"id":"call-active","type":"function","function":{"name":"calculate","arguments":"{invalid"}}]})}
                else {json!({"role":"assistant","content":alias})}
        }], "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})
    } else {
        json!({"id":"resp-active", "object":"response", "status":"completed", "model":"wire",
            "output":if tool {json!([{"type":"function_call","id":"fc-active","call_id":"call-active","name":"calculate","arguments":"{invalid","status":"completed"}])}
                else {json!([{"id":"msg-active","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":alias,"annotations":[]}]}])},
            "usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}})
    };
    let result = if matches!(outcome, Outcome::Refusal | Outcome::ContentFilter) {
        if state.chat {
            json!({"id":"chat-accepted-terminal","object":"chat.completion","model":"wire","choices":[{"index":0,"finish_reason":if matches!(outcome,Outcome::ContentFilter) {"content_filter"} else {"stop"},"message":if matches!(outcome,Outcome::Refusal) {json!({"role":"assistant","content":null,"refusal":"controlled refusal"})} else {json!({"role":"assistant","content":""})}}]})
        } else if matches!(outcome, Outcome::ContentFilter) {
            json!({"id":"filtered","object":"response","status":"incomplete","model":"wire","incomplete_details":{"reason":"content_filter"},"output":[]})
        } else {
            json!({"id":"refusal","object":"response","status":"completed","model":"wire","output":[{"id":"refusal-message","type":"message","role":"assistant","status":"completed","content":[{"type":"refusal","refusal":"controlled refusal"}]}]})
        }
    } else if state.protocol == "anthropic" {
        json!({"id":"msg-active","type":"message","role":"assistant","model":"wire","content":[{"type":"text","text":alias}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}})
    } else if state.protocol == "gemini" {
        json!({"candidates":[{"content":{"role":"model","parts":[{"text":alias}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}})
    } else if matches!(outcome, Outcome::Empty) {
        if state.chat {
            json!({"id":"empty","object":"chat.completion","model":"wire","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":""}}]})
        } else {
            json!({"id":"empty","object":"response","status":"completed","model":"wire","output":[]})
        }
    } else {
        result
    };
    if body["stream"] == true && matches!(outcome, Outcome::Ok) {
        let frames = if state.chat {
            format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"id":"chat-active","object":"chat.completion.chunk","model":"wire","choices":[{"index":0,"delta":{"role":"assistant","content":alias},"finish_reason":null}]}),
                json!({"id":"chat-active","object":"chat.completion.chunk","model":"wire","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
            )
        } else {
            format!(
                "event: response.completed\ndata: {}\n\n",
                json!({"type":"response.completed","response":result})
            )
        };
        return Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(frames))
            .unwrap();
    }
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(result.to_string()))
        .unwrap()
}

struct Entry {
    base: String,
    handle: Option<V3ServerAggregateHandle>,
    task: tokio::task::JoinHandle<()>,
    state: Arc<Upstream>,
    ports: [u16; 2],
    manifest: routecodex_v3_config::V3Config05ManifestPublished,
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.task.abort();
        if let Some(handle) = self.handle.take() {
            tokio::spawn(async move {
                handle.shutdown().await;
            });
        }
    }
}
impl Entry {
    async fn start(strategy: &str, retries: u32, disposition: &str, chat: bool) -> Self {
        Self::start_with_members(strategy, retries, disposition, chat, &["A", "B"]).await
    }

    async fn start_with_members(
        strategy: &str,
        retries: u32,
        disposition: &str,
        chat: bool,
        members: &[&str],
    ) -> Self {
        Self::start_with_protocol(
            strategy,
            retries,
            disposition,
            if chat { "openai_chat" } else { "responses" },
            members,
        )
        .await
    }
    async fn start_with_protocol(
        strategy: &str,
        retries: u32,
        disposition: &str,
        protocol: &'static str,
        members: &[&str],
    ) -> Self {
        Self::start_with_protocol_and_pools(strategy, retries, disposition, protocol, members, None)
            .await
    }

    async fn start_with_protocol_and_pools(
        strategy: &str,
        retries: u32,
        disposition: &str,
        protocol: &'static str,
        members: &[&str],
        pools: Option<&str>,
    ) -> Self {
        let chat = protocol == "openai_chat";
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let port = test_ports::free_port();
        assert!(![4444, 7777].contains(&port) && ![4444, 7777].contains(&upstream_port));
        let state = Arc::new(Upstream {
            script: Mutex::new(Script::default()),
            chat,
            protocol,
        });
        let app = Router::new()
            .route("/v1/responses", post(upstream))
            .route("/v1/chat/completions", post(upstream))
            .fallback(post(upstream))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        for alias in ["A", "B", "C"] {
            std::env::set_var(
                format!("ACTIVE_PUBLIC_{alias}"),
                format!("active-public-{alias}"),
            );
        }
        let default_pool = format!(
            r#"[route_groups.active_public.pools.default]
selection = {{ strategy = "{strategy}" }}
active_keys = {{members=[{members}],retries={retries},on_failure="{disposition}"}}
targets = [{{kind="provider_model",provider="controlled",model="wire",priority=1,weight=1}}]
"#,
            members = members
                .iter()
                .map(|alias| format!("{{provider=\"controlled\",alias=\"{alias}\"}}"))
                .collect::<Vec<_>>()
                .join(",")
        );
        let source = format!(
            r#"
version = 3
{declaration}
[servers.active_public]
bind = "127.0.0.1"
port = {port}
routing_group = "active_public"
endpoints = ["responses", "openai_chat", "anthropic", "gemini"]
{execution}
[providers.controlled]
type = "{protocol}"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "wire"
auth = {{ type = "api_key", entries = [{{alias="A",env="ACTIVE_PUBLIC_A"}},{{alias="B",env="ACTIVE_PUBLIC_B"}},{{alias="C",env="ACTIVE_PUBLIC_C"}}] }}
[providers.controlled.models.wire]
wire_name = "wire"
capabilities = ["text", "tools"]
{pools}
"#,
            declaration = hub_v1_fixture::hub_v1_test_declaration(),
            execution = hub_v1_fixture::hub_v1_server_execution("active_public"),
            protocol = protocol,
            pools = pools.unwrap_or(&default_pool),
        );
        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(&source).expect("active-key authoring"),
        )
        .expect("active-key manifest");
        let handle = spawn_v3_server_aggregate(manifest.clone())
            .await
            .expect("isolated active-key listener");
        Self {
            base: format!("http://{}", handle.listeners[0].addr),
            handle: Some(handle),
            task,
            state,
            ports: [port, upstream_port],
            manifest,
        }
    }
    fn script(&self, alias: &str, outcomes: &[Outcome]) {
        self.state
            .script
            .lock()
            .unwrap()
            .next
            .insert(alias.into(), outcomes.iter().copied().collect());
    }
    fn calls(&self) -> Vec<String> {
        self.state
            .script
            .lock()
            .unwrap()
            .calls
            .iter()
            .map(|(a, _)| a.clone())
            .collect()
    }
    async fn send(
        &self,
        session: &str,
        input: Value,
    ) -> Result<(StatusCode, String), reqwest::Error> {
        self.send_model(session, "client", input).await
    }

    async fn send_model(
        &self,
        session: &str,
        model: &str,
        input: Value,
    ) -> Result<(StatusCode, String), reqwest::Error> {
        let response = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap()
            .post(format!("{}/v1/responses",self.base)).header("x-session-id",session)
            .json(&json!({"model":model,"input":input,"tools":[{"type":"function","name":"calculate","parameters":{"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}}]}))
            .send().await?;
        let status = response.status();
        Ok((status, response.text().await?))
    }
    async fn request(&self, session: &str) -> String {
        let (status, body) = self
            .send(session, json!("controlled input"))
            .await
            .expect("public response");
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
    async fn queue(&self) -> Value {
        reqwest::get(format!("{}/_routecodex/selection/active-keys", self.base))
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn release(&self, alias: &str) -> Value {
        reqwest::Client::new().post(format!("{}/_routecodex/selection/active-keys/release", self.base))
            .json(&json!({"routing_group_id":"active_public","pool_id":"default","provider_id":"controlled",
                "interface_id":"default","model_id":"wire","auth_alias":alias}))
            .send().await.unwrap().error_for_status().unwrap().json().await.unwrap()
    }
    async fn restart_fixture(&mut self) {
        self.handle.take().unwrap().shutdown().await;
        wait_for_listener_close(self.ports[0]).await;
        self.handle = Some(
            spawn_v3_server_aggregate(self.manifest.clone())
                .await
                .unwrap(),
        );
    }
    async fn stop(mut self) {
        eprintln!("active-public actual upstream aliases: {:?}", self.calls());
        if let Some(handle) = self.handle.take() {
            handle.shutdown().await;
        }
        self.task.abort();
        let _ = (&mut self.task).await;
        for port in self.ports {
            wait_for_listener_close(port).await;
        }
        eprintln!(
            "active-public cleanup: entry/upstream ports {:?} closed; no child processes",
            self.ports
        );
    }
}
async fn wait_for_listener_close(port: u16) {
    wait_for_listener_address_close(std::net::SocketAddr::from(([127, 0, 0, 1], port))).await;
}

async fn wait_for_listener_address_close(address: std::net::SocketAddr) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while tokio::net::TcpStream::connect(address).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned fixture listener must close");
}
fn text(body: &str) -> String {
    let body: Value = serde_json::from_str(body).expect("Responses JSON");
    body["output"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|o| o["content"].as_array().into_iter().flatten())
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}

#[tokio::test]
async fn sticky_success_feedback_covers_chat_anthropic_and_gemini_entries() {
    let _home = LOCK.lock().await;
    for protocol in ["openai_chat", "anthropic", "gemini"] {
        let entry = Entry::start("sticky", 3, "tail", false).await;
        let (path, body) = match protocol {
            "openai_chat" => (
                "/v1/chat/completions",
                json!({"model":"client","stream":false,
                "messages":[{"role":"user","content":"controlled input"}]}),
            ),
            "anthropic" => (
                "/v1/messages",
                json!({"model":"client","max_tokens":16,"stream":false,
                "messages":[{"role":"user","content":"controlled input"}]}),
            ),
            _ => (
                "/v1beta/models/client:generateContent",
                json!({"contents":[{
                "role":"user","parts":[{"text":"controlled input"}]}]}),
            ),
        };
        let mut results = Vec::new();
        for session in ["entry-s1", "entry-s2", "entry-s1"] {
            let response = reqwest::Client::new()
                .post(format!("{}{path}", entry.base))
                .header("x-session-id", session)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .unwrap();
            results.push((response.status(), response.text().await.unwrap()));
        }
        let calls = entry.calls();
        entry.stop().await;
        let mut output = Vec::new();
        for (status, response) in results {
            assert_eq!(status, StatusCode::OK, "{protocol}: {response}");
            let response: Value = serde_json::from_str(&response).unwrap();
            let text = match protocol {
                "openai_chat" => response["choices"][0]["message"]["content"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                "anthropic" => response["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>(),
                _ => response["candidates"][0]["content"]["parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>(),
            };
            output.push(text);
        }
        assert_eq!(
            output,
            ["A", "B", "A"],
            "{protocol}: only accepted business success binds"
        );
        assert_eq!(
            calls,
            ["A", "B", "A"],
            "{protocol}: fresh sessions spread then reuse success"
        );
    }
}

#[tokio::test]
async fn confirmed_quota_switches_early_and_queue_release_does_not_clear_health() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 3, "hold", chat).await;
        entry.script("A", &[Outcome::Account(429, "insufficient_quota")]);
        let first = text(&entry.request("quota-first").await);
        let before = entry.queue().await;
        let release = entry.release("A").await;
        let after = entry.queue().await;
        let second = text(&entry.request("quota-next").await);
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!((first.as_str(), second.as_str()), ("B", "B"));
        assert_eq!(
            calls,
            ["A", "B", "B"],
            "confirmed quota is not repeated unchanged"
        );
        assert_eq!(before["pools"][0]["strategy"], "active_queue");
        assert_eq!(
            before["pools"][0]["held"],
            json!([]),
            "one failure is below the queue threshold"
        );
        assert_eq!(release["released"], false);
        for status in [before, after] {
            let a = status["pools"][0]["health"]
                .as_array()
                .unwrap()
                .iter()
                .find(|member| member["auth_alias"] == "A")
                .unwrap();
            assert_eq!(
                a["eligible"], false,
                "queue release cannot clear quota cooldown"
            );
        }
    }
}

#[tokio::test]
async fn final_only_account_errors_count_once_each_until_fourth_failure_hold() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        for (status, code) in [
            (401, "invalid_api_key"),
            (403, "permission_error"),
            (429, "insufficient_quota"),
        ] {
            let entry = Entry::start_with_members("active_queue", 3, "hold", chat, &["A"]).await;
            entry.script("A", &[Outcome::Account(status, code); 4]);
            let mut responses = Vec::new();
            for request in 0..4 {
                responses.push(
                    entry
                        .send(&format!("single-{request}"), json!("controlled input"))
                        .await,
                );
            }
            let queue = entry.queue().await;
            let exhausted = entry
                .send("single-exhausted", json!("controlled input"))
                .await;
            let calls = entry.calls();
            entry.stop().await;
            for response in responses {
                let (actual, body) = response.expect("actual final HTTP error");
                assert_eq!(actual.as_u16(), status, "{body}");
                assert!(body.contains("controlled account failure"), "{body}");
            }
            assert_eq!(calls, ["A", "A", "A", "A"]);
            assert_eq!(queue["pools"][0]["held"][0]["auth_alias"], "A");
            assert_eq!(
                queue["pools"][0]["health"][0]["eligible"], true,
                "the final-only identity stays Provider-health neutral"
            );
            assert!(
                exhausted.is_err(),
                "a held last key cannot fabricate an empty completion"
            );
        }
    }
}

#[tokio::test]
async fn held_key_survives_fixture_reconstruction_and_release_rejoins_tail() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let mut entry = Entry::start("active_queue", 3, "hold", chat).await;
        entry.script("A", &[Outcome::Http(500); 4]);
        let first = text(&entry.request("durable-first").await);
        let calls_before = entry.calls();
        entry.restart_fixture().await;
        let queue = entry.queue().await;
        let calls_after = entry.calls();
        let release = entry.release("A").await;
        let released = entry.queue().await;
        let next = text(&entry.request("durable-next").await);
        entry.stop().await;
        assert_eq!((first.as_str(), next.as_str()), ("B", "B"));
        assert_eq!(
            calls_before, calls_after,
            "status after reconstruction must not probe or dispatch"
        );
        assert_eq!(queue["pools"][0]["held"][0]["auth_alias"], "A");
        assert_eq!(release["released"], true);
        assert_eq!(released["pools"][0]["held"], json!([]));
        assert_eq!(released["pools"][0]["order"][0]["auth_alias"], "B");
        assert_eq!(released["pools"][0]["order"][1]["auth_alias"], "A");
    }
}

#[tokio::test]
async fn corrupt_hold_state_fails_startup_without_releasing_or_leaking_listener() {
    let _home = LOCK.lock().await;
    let mut entry = Entry::start("active_queue", 3, "hold", false).await;
    entry.script("A", &[Outcome::Http(500); 4]);
    entry.request("corrupt-hold").await;
    entry.handle.take().unwrap().shutdown().await;
    wait_for_listener_close(entry.ports[0]).await;
    let config = routecodex_v3_config::default_v3_config_path(std::path::PathBuf::from(
        std::env::var_os("HOME").unwrap(),
    ));
    let file = config.with_file_name(format!("active-keys-127.0.0.1_{}.json", entry.ports[0]));
    assert!(
        file.is_file(),
        "holds must use the separate listener state file"
    );
    std::fs::write(&file, "not valid persisted state").unwrap();
    let result = spawn_v3_server_aggregate(entry.manifest.clone()).await;
    assert!(
        result.is_err(),
        "corrupt holds must never fall back to empty state"
    );
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", entry.ports[0]))
            .await
            .is_err(),
        "startup failure must close its already-bound listener"
    );
    entry.stop().await;
}

#[tokio::test]
async fn active_queue_success_retains_head_and_excludes_inactive_alias() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 3, "hold", chat).await;
        let mut results = Vec::new();
        for session in ["one", "two", "three"] {
            results.push(text(&entry.request(session).await));
        }
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(results, ["A", "A", "A"], "chat={chat}");
        assert_eq!(calls, ["A", "A", "A"]);
    }
}

#[tokio::test]
async fn fourth_recoverable_failure_reselects_and_next_request_keeps_b() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        for disposition in ["hold", "tail"] {
            let entry = Entry::start("active_queue", 3, disposition, chat).await;
            entry.script("A", &[Outcome::Http(500); 4]);
            let first = text(&entry.request("failure").await);
            let next = text(&entry.request("next").await);
            let calls = entry.calls();
            entry.stop().await;
            assert_eq!(
                (first.as_str(), next.as_str()),
                ("B", "B"),
                "chat={chat} disposition={disposition}"
            );
            assert_eq!(calls, ["A", "A", "A", "A", "B", "B"]);
        }
    }
}

#[tokio::test]
async fn third_failure_then_success_does_not_dispose_active_head() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 3, "tail", chat).await;
        entry.script("A", &[Outcome::Http(500); 3]);
        let first = text(&entry.request("third").await);
        let next = text(&entry.request("next").await);
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!((first.as_str(), next.as_str()), ("A", "A"));
        assert_eq!(calls, ["A", "A", "A", "A", "A"]);
    }
}

#[tokio::test]
async fn round_robin_uses_only_active_aliases_and_retries_do_not_consume_turns() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("round_robin", 3, "tail", chat).await;
        entry.script("A", &[Outcome::Http(500), Outcome::Ok]);
        let mut results = Vec::new();
        for session in ["r1", "r2", "r3", "r4"] {
            results.push(text(&entry.request(session).await));
        }
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(results, ["A", "B", "A", "B"], "chat={chat}");
        assert_eq!(calls, ["A", "A", "B", "A", "B"]);
    }
}

#[tokio::test]
async fn sticky_sessions_spread_then_keep_their_successful_alias() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("sticky", 3, "tail", chat).await;
        let mut results = Vec::new();
        for session in ["S1", "S2", "S1", "S2"] {
            results.push(text(&entry.request(session).await));
        }
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(results, ["A", "B", "A", "B"]);
        assert_eq!(calls, ["A", "B", "A", "B"]);
    }
}

#[tokio::test]
async fn sticky_failed_attempt_does_not_create_a_successful_preference() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("sticky", 0, "tail", chat).await;
        entry.script("A", &[Outcome::Http(500)]);
        let first = text(&entry.request("failed-before-binding").await);
        let followup = text(&entry.request("failed-before-binding").await);
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!((first.as_str(), followup.as_str()), ("B", "B"));
        assert_eq!(calls, ["A", "B", "B"], "failed selection must not pin A");
    }
}

#[tokio::test]
async fn sticky_tail_fourth_failure_clears_old_binding_and_allows_later_fresh_a() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("sticky", 3, "tail", chat).await;
        let initial = text(&entry.request("S1").await);
        entry.script("A", &[Outcome::Http(500); 4]);
        let replacement = text(&entry.request("S1").await);
        let retained = text(&entry.request("S1").await);
        // Fresh sessions use queue/cursor assignment, so A must remain eligible
        // after tail disposition without reviving S1's obsolete preference.
        let fresh1 = text(&entry.request("fresh1").await);
        let fresh2 = text(&entry.request("fresh2").await);
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(initial, "A");
        assert_eq!(replacement, "B");
        assert_eq!(retained, "B");
        assert!([fresh1.as_str(), fresh2.as_str()].contains(&"A"));
        assert_eq!(&calls[..7], ["A", "A", "A", "A", "A", "B", "B"]);
        assert!(!calls.iter().any(|a| a == "C"));
    }
}

#[tokio::test]
async fn failure_streak_accumulates_across_requests_without_retry_budget_reset() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 0, "tail", chat).await;
        entry.script("A", &[Outcome::Http(500); 4]);
        let mut results = Vec::new();
        for session in ["f1", "f2", "f3", "f4", "f5"] {
            results.push(text(&entry.request(session).await));
        }
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(results, ["B", "B", "B", "B", "B"]);
        assert_eq!(
            calls,
            ["A", "B", "A", "B", "A", "B", "A", "B", "B"],
            "chat={chat}: exactly fourth failure moves A to tail"
        );
    }
}

#[tokio::test]
async fn nonretryable_http_failures_accumulate_without_unchanged_same_key_retries() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        // 403 retains its separate health threshold; four failures must not
        // become an immediate auth cooldown. 400/422 are request rejections.
        for status in [400, 403, 422] {
            let entry = Entry::start("active_queue", 3, "tail", chat).await;
            entry.script("A", &[Outcome::Http(status); 4]);
            let mut results = Vec::new();
            for session in ["reject1", "reject2", "reject3", "reject4", "after"] {
                results.push(text(&entry.request(session).await));
            }
            let calls = entry.calls();
            entry.stop().await;
            assert_eq!(
                results,
                ["B", "B", "B", "B", "B"],
                "HTTP{status} chat={chat}"
            );
            assert_eq!(
                calls,
                ["A", "B", "A", "B", "A", "B", "A", "B", "B"],
                "HTTP{status} chat={chat}: retry budget is not the shared failure streak"
            );
        }
    }
}

#[tokio::test]
async fn exhausted_final_complete_http_error_preserves_actual_status_and_body() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 3, "tail", chat).await;
        entry.script("A", &[Outcome::Http(500); 4]);
        entry.script("B", &[Outcome::Http(503); 4]);
        let response = entry.send("final-http", json!("controlled input")).await;
        let calls = entry.calls();
        entry.stop().await;
        let (status, body) = response.expect("complete final HTTP error must remain projectable");
        assert_eq!(
            status.as_u16(),
            503,
            "actual final B status, not earlier A status: {body}"
        );
        assert!(
            body.contains("ordinary controlled upstream failure alias=B status=503"),
            "real final error body: {body}"
        );
        assert_eq!(calls, ["A", "A", "A", "A", "B", "B", "B", "B"]);
    }
}

#[tokio::test]
async fn actual_final_truncation_never_projects_an_earlier_http_error_or_cycles() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 3, "tail", chat).await;
        entry.script("A", &[Outcome::Http(500); 4]);
        entry.script("B", &[Outcome::Truncated; 4]);
        let response = entry.send("terminal", json!("controlled input")).await;
        let calls = entry.calls();
        entry.stop().await;
        assert!(response.is_err(),"final transport failure must be detectable, never stale 500 or normal completion: {response:?}");
        assert!(
            calls.len() >= 5,
            "four A failures must precede final B transport failure: {calls:?}"
        );
        assert_eq!(&calls[..4], ["A", "A", "A", "A"]);
        assert!(calls[4..].iter().all(|a| a == "B"));
        assert!(
            !calls[4..].is_empty() && calls.len() <= 8,
            "no closed-episode retry or inactive fallback: {calls:?}"
        );
    }
}

#[tokio::test]
async fn invalid_model_arguments_are_success_and_client_error_history_stays_paired() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 3, "tail", chat).await;
        entry.script("A", &[Outcome::InvalidTool]);
        let first = entry.request("tool-session").await;
        let parsed: Value = serde_json::from_str(&first).unwrap();
        let call = parsed["output"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["type"] == "function_call")
            .cloned();
        let Some(call) = call else {
            let calls = entry.calls();
            entry.stop().await;
            panic!(
                "model invalid arguments must be forwarded; upstream={calls:?}, response={first}"
            );
        };
        let arguments = call["arguments"].clone();
        let call_id = call["call_id"].clone();
        let (status,next)=entry.send("tool-session",json!([
            {"role":"user","content":"calculate"},call,
            {"type":"function_call_output","call_id":call_id,"output":"client error: invalid JSON arguments"}
        ])).await.unwrap();
        let captures = entry.state.script.lock().unwrap().calls.clone();
        entry.stop().await;
        assert_eq!(arguments, "{invalid");
        assert_eq!(status, StatusCode::OK, "{next}");
        assert_eq!(text(&next), "A");
        assert_eq!(
            captures.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>(),
            ["A", "A"]
        );
        let wire = &captures[1].1;
        if chat {
            let messages = wire["messages"].as_array().unwrap();
            assert!(messages
                .iter()
                .any(|m| m["tool_calls"][0]["id"] == "call-active"
                    && m["tool_calls"][0]["function"]["arguments"] == "{invalid"));
            assert!(messages.iter().any(|m| m["role"] == "tool"
                && m["tool_call_id"] == "call-active"
                && m["content"] == "client error: invalid JSON arguments"));
        } else {
            let input = wire["input"].as_array().unwrap();
            assert!(input.iter().any(|m| m["type"] == "function_call"
                && m["call_id"] == "call-active"
                && m["arguments"] == "{invalid"));
            assert!(input.iter().any(|m| m["type"] == "function_call_output"
                && m["call_id"] == "call-active"
                && m["output"] == "client error: invalid JSON arguments"));
        }
    }
}

#[tokio::test]
async fn decode_and_empty_response_failures_reselect_without_unchanged_retry() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        for failure in [Outcome::InvalidJson, Outcome::Empty] {
            let entry = Entry::start("active_queue", 3, "tail", chat).await;
            entry.script("A", &[failure; 4]);
            for attempt in 0..4 {
                assert_eq!(
                    text(&entry.request(&format!("processing-{attempt}")).await),
                    "B"
                );
            }
            assert_eq!(text(&entry.request("processing-next").await), "B");
            let calls = entry.calls();
            entry.stop().await;
            assert_eq!(calls, ["A","B","A","B","A","B","A","B","B"],
                "{failure:?}: dispatched response failures count across requests and the fourth invalidates A");
        }
    }
}

#[tokio::test]
async fn cross_protocol_fourth_failure_and_round_robin_retry_keep_actual_turns() {
    let _home = LOCK.lock().await;
    for protocol in ["openai_chat", "anthropic", "gemini"] {
        let entry = Entry::start("round_robin", 3, "tail", false).await;
        let (path, body) = match protocol {
            "openai_chat" => (
                "/v1/chat/completions",
                json!({"model":"client","messages":[{"role":"user","content":"hello"}]}),
            ),
            "anthropic" => (
                "/v1/messages",
                json!({"model":"client","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}),
            ),
            _ => (
                "/v1beta/models/client:generateContent",
                json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}]}),
            ),
        };
        entry.script("A", &[Outcome::Http(500); 4]);
        for session in ["cross-old", "cross-next", "cross-old"] {
            let response = reqwest::Client::new()
                .post(format!("{}{path}", entry.base))
                .header("x-session-id", session)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .unwrap();
            let status = response.status();
            let response = response.text().await.unwrap();
            assert_eq!(status, StatusCode::OK, "{protocol}: {response}");
        }
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(calls, ["A","A","A","A","B","A","B"],
            "{protocol}: lookahead cannot consume a round-robin turn; fourth failure sends A to tail");
    }
}

#[tokio::test]
async fn same_protocol_generic_direct_retries_then_holds_and_releases_the_key() {
    let _home = LOCK.lock().await;
    for protocol in ["openai_chat", "anthropic", "gemini"] {
        let entry =
            Entry::start_with_protocol("active_queue", 3, "hold", protocol, &["A", "B"]).await;
        let (path, body) = match protocol {
            "openai_chat" => (
                "/v1/chat/completions",
                json!({"model":"client","messages":[{"role":"user","content":"hello"}]}),
            ),
            "anthropic" => (
                "/v1/messages",
                json!({"model":"client","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}),
            ),
            _ => (
                "/v1beta/models/client:generateContent",
                json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}]}),
            ),
        };
        entry.script("A", &[Outcome::Http(500); 4]);
        for _ in 0..2 {
            let response = reqwest::Client::new()
                .post(format!("{}{path}", entry.base))
                .header("x-session-id", "generic-direct")
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .unwrap();
            let status = response.status();
            let text = response.text().await.unwrap();
            assert_eq!(status, StatusCode::OK, "{protocol}: {text}");
            assert!(text.contains('B'), "{protocol}: {text}");
        }
        let held = entry.queue().await;
        assert_eq!(held["pools"][0]["held"][0]["auth_alias"], "A");
        assert_eq!(entry.release("A").await["released"], true);
        let calls = entry.calls();
        entry.stop().await;
        assert_eq!(
            calls,
            ["A", "A", "A", "A", "B", "B"],
            "{protocol}: same-protocol Direct must apply the shared policy"
        );
    }
}

#[tokio::test]
async fn cancellation_does_not_count_as_a_delivery_failure_or_hold_a_key() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let mut entry = Entry::start_with_members("active_queue", 3, "hold", chat, &["A"]).await;
        entry.script("A", &[Outcome::GatedOk; 4]);
        let gate = business_recovery::GateOwner::new();
        let client = reqwest::Client::new();
        let mut cancelled = Vec::new();
        for i in 0..4 {
            let request = tokio::spawn(
                client
                    .post(format!("{}/v1/responses", entry.base))
                    .header("x-session-id", format!("cancel-{i}"))
                    .json(&json!({"model":"client","input":format!("cancel input {i}")}))
                    .send(),
            );
            gate.entered().await;
            request.abort();
            cancelled.push(request.await.is_err_and(|error| error.is_cancelled()));
        }
        let held = entry.queue().await;
        let follow_up = entry
            .send("after-cancel", json!("after cancellation"))
            .await;
        for _ in 0..4 {
            gate.release();
        }
        let recorder = Arc::clone(&entry.state);
        let prepared = tokio::time::timeout(
            Duration::from_secs(5),
            entry.handle.take().unwrap().prepare_for_exec(),
        )
        .await
        .expect("accepted proxy work must finish after gated replies are released");
        drop(prepared);
        entry.stop().await;
        let calls = recorder.script.lock().unwrap().calls.clone();
        eprintln!(
            "final Provider aliases after shutdown: {:?}",
            calls.iter().map(|(alias, _)| alias).collect::<Vec<_>>()
        );
        assert!(cancelled.into_iter().all(|cancelled| cancelled));
        assert_eq!(
            calls
                .iter()
                .map(|(alias, _)| alias.as_str())
                .collect::<Vec<_>>(),
            ["A", "A", "A", "A", "A"],
            "each cancelled request and the follow-up reached Provider once"
        );
        for i in 0..4 {
            let input = format!("cancel input {i}");
            assert_eq!(
                calls
                    .iter()
                    .filter(|(_, body)| body.to_string().contains(&input))
                    .count(),
                1,
                "cancelled input must never be replayed: {input}"
            );
        }
        assert_eq!(held["pools"][0]["held"], json!([]));
        assert!(calls
            .last()
            .unwrap()
            .1
            .to_string()
            .contains("after cancellation"));
        let (status, body) = follow_up.unwrap();
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(text(&body), "A");
    }
}

#[tokio::test]
async fn accepted_refusal_and_content_filter_reset_the_failure_streak() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        for accepted in [Outcome::Refusal, Outcome::ContentFilter] {
            let entry = Entry::start("active_queue", 3, "hold", chat).await;
            entry.script(
                "A",
                &[
                    Outcome::Http(500),
                    Outcome::Http(500),
                    Outcome::Http(500),
                    accepted,
                ],
            );
            let (status, body) = entry
                .send("terminal-success", json!("hello"))
                .await
                .unwrap();
            assert_eq!(status, StatusCode::OK, "{accepted:?}: {body}");
            assert!(
                body.contains(if matches!(accepted, Outcome::Refusal) {
                    "controlled refusal"
                } else {
                    "content_filter"
                }),
                "{body}"
            );
            entry.script("A", &[Outcome::Http(500), Outcome::Ok]);
            assert_eq!(text(&entry.request("terminal-success").await), "A");
            assert_eq!(entry.queue().await["pools"][0]["held"], json!([]));
            let calls = entry.calls();
            entry.stop().await;
            assert_eq!(calls, ["A", "A", "A", "A", "A", "A"]);
        }
    }
}

#[tokio::test]
async fn streaming_failure_recovery_commits_only_the_accepted_keys_business_frames() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        for strategy in ["active_queue", "round_robin", "sticky"] {
            let entry = Entry::start(strategy, 3, "hold", chat).await;
            entry.script("A", &[Outcome::Http(500); 4]);
            let response = reqwest::Client::new()
                .post(format!("{}/v1/responses", entry.base))
                .header("x-session-id", "streaming-session")
                .json(&json!({"model":"client","input":"stream hello","stream":true}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers()["content-type"]
                .to_str()
                .unwrap()
                .contains("text/event-stream"));
            let body = response.text().await.unwrap();
            let calls = entry.calls();
            let queue = entry.queue().await;
            entry.stop().await;
            assert!(body.contains("response.completed"), "{strategy}: {body}");
            assert!(body.contains("\"text\":\"B\""), "{strategy}: {body}");
            assert!(
                !body.contains("ordinary controlled upstream failure"),
                "{body}"
            );
            assert!(!body.contains("\"text\":\"A\""), "{body}");
            assert_eq!(calls, ["A", "A", "A", "A", "B"]);
            assert_eq!(queue["pools"][0]["held"][0]["auth_alias"], "A");
        }
    }
}

// This explicit test entry hosts the shipped admin view and real RCC library
// listener. Its private lifecycle adapter reconstructs only that test listener;
// it cannot invoke an installed RCC or touch production ports.
#[cfg(unix)]
struct BrowserFixtureControl {
    admin: routecodex_v3_admin::AppState,
    config_path: std::path::PathBuf,
    runtime: tokio::sync::Mutex<Option<V3ServerAggregateHandle>>,
    upstream: Arc<Upstream>,
    business_port: u16,
    business_ip: std::net::IpAddr,
    upstream_url: String,
    stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[cfg(unix)]
fn browser_fixture_manifest(
    state: &BrowserFixtureControl,
) -> Result<routecodex_v3_config::V3Config05ManifestPublished, String> {
    let source = state
        .admin
        .store
        .read_authoring()
        .map_err(|error| error.to_string())?;
    let manifest = state
        .admin
        .store
        .validate(&source)
        .map_err(|error| error.to_string())?;
    let isolated = manifest.servers.len() == 1
        && manifest.servers.get("active_public").is_some_and(|server| {
            server.bind == state.business_ip.to_string() && server.port == state.business_port
        })
        && manifest.providers.len() == 1
        && manifest
            .providers
            .get("controlled")
            .is_some_and(|provider| {
                provider
                    .interfaces
                    .values()
                    .all(|interface| interface.base_url == state.upstream_url)
            });
    if !isolated {
        return Err("browser fixture can reload only its owned listener/upstream".into());
    }
    Ok(manifest)
}

#[cfg(unix)]
async fn browser_fixture_shutdown(handle: V3ServerAggregateHandle, config: &std::path::Path) {
    let paths = routecodex_v3_config::v3_active_key_control_paths(config, "active_public").unwrap();
    let endpoint: Value =
        serde_json::from_slice(&paths.read().expect("owned control record")).unwrap();
    let control = endpoint["control_addr"].as_str().unwrap().parse().unwrap();
    assert!(handle.shutdown().await.is_empty());
    wait_for_listener_address_close(control).await;
    assert!(
        matches!(paths.read(), Err(error) if error.kind() == std::io::ErrorKind::NotFound),
        "owned control endpoint record must close with the listener"
    );
    assert!(
        !paths.root.exists(),
        "owned empty control directory chain must close"
    );
    eprintln!("browser control cleanup: endpoint={control} record_absent=true");
}

#[cfg(unix)]
async fn browser_fixture_reload(
    State(state): State<Arc<BrowserFixtureControl>>,
) -> (StatusCode, Json<Value>) {
    let manifest = match browser_fixture_manifest(&state) {
        Ok(manifest) => manifest,
        Err(error) => return (StatusCode::BAD_REQUEST, Json(json!({"error":error}))),
    };
    let mut runtime = state.runtime.lock().await;
    if let Some(previous) = runtime.take() {
        browser_fixture_shutdown(previous, &state.config_path).await;
        wait_for_listener_address_close(std::net::SocketAddr::new(
            state.business_ip,
            state.business_port,
        ))
        .await;
    }
    match routecodex_v3_server::spawn_v3_server_aggregate_with_admin(
        manifest,
        None,
        Some(state.config_path.clone()),
    )
    .await
    {
        Ok(handle) => {
            *runtime = Some(handle);
            let status = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!(
                    "http://{}/health",
                    std::net::SocketAddr::new(state.business_ip, state.business_port)
                ))
                .send()
                .await;
            match status {
                Ok(response) if response.status().is_success() => (
                    StatusCode::OK,
                    Json(json!({"ok":true,"fixture":"actual isolated listener reconstructed"})),
                ),
                _ => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error":"reconstructed business listener health is unavailable"})),
                ),
            }
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":error.to_string()})),
        ),
    }
}

#[cfg(unix)]
async fn browser_fixture_script(
    State(state): State<Arc<BrowserFixtureControl>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let Some(alias) = body["alias"]
        .as_str()
        .filter(|alias| ["A", "B", "C"].contains(alias))
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"unknown fixture alias"})),
        );
    };
    let status = body["status"].as_u64().unwrap_or(500);
    if !(400..600).contains(&status) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"fixture failure requires a real HTTP error"})),
        );
    }
    let count = body["count"].as_u64().unwrap_or(4) as usize;
    let mut script = state.upstream.script.lock().unwrap();
    script.calls.clear();
    script.next.clear();
    script.next.insert(
        alias.into(),
        vec![Outcome::Http(status as u16); count].into(),
    );
    (StatusCode::OK, Json(json!({"ok":true})))
}

#[cfg(unix)]
async fn browser_fixture_calls(State(state): State<Arc<BrowserFixtureControl>>) -> Json<Value> {
    let calls = state
        .upstream
        .script
        .lock()
        .unwrap()
        .calls
        .iter()
        .map(|(alias, _)| alias.clone())
        .collect::<Vec<_>>();
    Json(json!({"calls":calls}))
}

#[cfg(unix)]
async fn browser_fixture_stop(State(state): State<Arc<BrowserFixtureControl>>) -> Json<Value> {
    if let Some(stop) = state.stop.lock().unwrap().take() {
        let _ = stop.send(());
    }
    Json(json!({"stopping":true}))
}

#[cfg(unix)]
struct BrowserFixtureEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
#[cfg(unix)]
impl BrowserFixtureEnv {
    fn set(&mut self, key: &'static str, value: impl AsRef<std::ffi::OsStr>) {
        self.0.push((key, std::env::var_os(key)));
        std::env::set_var(key, value);
    }
}
#[cfg(unix)]
impl Drop for BrowserFixtureEnv {
    fn drop(&mut self) {
        for (key, value) in self.0.iter().rev() {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "explicit interactive browser fixture; requires ACTIVE_BROWSER_INFO_PATH"]
async fn active_key_browser_fixture() {
    use std::os::unix::fs::PermissionsExt;
    let info_path =
        std::env::var_os("ACTIVE_BROWSER_INFO_PATH").expect("explicit browser evidence path");
    let _home = LOCK.lock().await;
    let root = routecodex_v3_config::default_v3_config_path(std::path::PathBuf::from(
        std::env::var_os("HOME").unwrap(),
    ));
    let config_dir = root.parent().unwrap();
    let canonical_root = std::env::var_os("ACTIVE_BROWSER_CANONICAL_BASENAME")
        .map(|basename| config_dir.join(basename))
        .unwrap_or_else(|| root.clone());
    std::fs::create_dir_all(config_dir.join("provider/controlled")).unwrap();
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    let business_port = test_ports::free_port();
    let business_ip: std::net::IpAddr = std::env::var("ACTIVE_BROWSER_BUSINESS_BIND")
        .unwrap_or_else(|_| "127.0.0.1".into())
        .parse()
        .expect("explicit isolated browser bind IP");
    let admin_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let admin_port = admin_listener.local_addr().unwrap().port();
    let control_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let control_port = control_listener.local_addr().unwrap().port();
    for port in [upstream_port, business_port, admin_port, control_port] {
        assert!(![4444, 7777].contains(&port));
    }
    let upstream_url = format!("http://127.0.0.1:{upstream_port}/v1");
    for alias in ["A", "B", "C"] {
        std::fs::write(
            config_dir.join(format!("{alias}.token")),
            format!("active-public-{alias}"),
        )
        .unwrap();
    }
    std::fs::write(
        config_dir.join("provider/controlled/config.v2.toml"),
        format!(
            r#"
version = "2.0.0"
providerId = "controlled"
[provider]
id = "controlled"
enabled = true
type = "responses"
baseURL = "{upstream_url}"
defaultModel = "wire"
[provider.auth]
type = "apikey"
entries = [{{alias="A",tokenFile="{}"}},{{alias="B",tokenFile="{}"}},{{alias="C",tokenFile="{}"}}]
[provider.models.wire]
wireName = "wire"
capabilities = ["text", "tools"]
supportsStreaming = true
"#,
            config_dir.join("A.token").display(),
            config_dir.join("B.token").display(),
            config_dir.join("C.token").display()
        ),
    )
    .unwrap();
    std::fs::write(&canonical_root, format!(r#"version = 3
[servers.active_public]
bind = "{business_ip}"
port = {business_port}
[servers.active_public.routes.default]
selection = {{ strategy = "active_queue" }}
active_keys = {{ members = [{{provider="controlled",alias="A"}},{{provider="controlled",alias="B"}}], retries=3, on_failure="hold" }}
tiers = [[{{ use = "controlled/wire" }}]]
"#)).unwrap();
    if canonical_root != root {
        std::os::unix::fs::symlink(&canonical_root, &root).unwrap();
    }
    let admin = routecodex_v3_admin::AppState::new(root.clone());
    let upstream_state = Arc::new(Upstream {
        script: Mutex::new(Script::default()),
        chat: false,
        protocol: "responses",
    });
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let control = Arc::new(BrowserFixtureControl {
        admin: admin.clone(),
        config_path: root.clone(),
        runtime: tokio::sync::Mutex::new(None),
        upstream: upstream_state.clone(),
        business_port,
        business_ip,
        upstream_url,
        stop: Mutex::new(Some(stop)),
    });
    let manifest = browser_fixture_manifest(&control)
        .expect("real user-config projection for isolated fixture");
    *control.runtime.lock().await = Some(
        routecodex_v3_server::spawn_v3_server_aggregate_with_admin(
            manifest,
            None,
            Some(root.clone()),
        )
        .await
        .unwrap(),
    );
    let fixture_bin = config_dir.join("fixture-bin");
    std::fs::create_dir(&fixture_bin).unwrap();
    let executable = fixture_bin.join("rccv3");
    std::fs::write(&executable, r#"#!/usr/bin/env python3
import json, os, sys, urllib.request
expected = ["restart", "-c", os.environ["ACTIVE_BROWSER_CONFIG"]]
if sys.argv[1:] != expected:
    print("isolated fixture refuses unrelated lifecycle arguments", file=sys.stderr)
    sys.exit(2)
request = urllib.request.Request(os.environ["ACTIVE_BROWSER_CONTROL_URL"] + "/reload", data=b"{}", headers={"Content-Type":"application/json"}, method="POST")
with urllib.request.urlopen(request, timeout=30) as response:
    result = json.load(response)
if not result.get("ok"):
    print(json.dumps(result), file=sys.stderr)
    sys.exit(1)
print(json.dumps(result))
"#).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut environment = BrowserFixtureEnv(Vec::new());
    let mut paths = vec![fixture_bin];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap()));
    environment.set("PATH", std::env::join_paths(paths).unwrap());
    environment.set("ACTIVE_BROWSER_CONFIG", &root);
    environment.set(
        "ACTIVE_BROWSER_CONTROL_URL",
        format!("http://127.0.0.1:{control_port}"),
    );
    assert_eq!(
        routecodex_v3_admin::api::deploy::resolve_lifecycle_executable(),
        Some(executable),
        "the browser fixture must never invoke an installed RCC lifecycle command"
    );
    let upstream_task = tokio::spawn(async move {
        axum::serve(
            upstream_listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(upstream_state),
        )
        .await
        .unwrap();
    });
    let admin_task = tokio::spawn(async move {
        axum::serve(
            admin_listener,
            routecodex_v3_admin::router(admin)
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let control_state = control.clone();
    let control_task = tokio::spawn(async move {
        axum::serve(
            control_listener,
            Router::new()
                .route("/reload", post(browser_fixture_reload))
                .route("/script", post(browser_fixture_script))
                .route("/calls", axum::routing::get(browser_fixture_calls))
                .route("/stop", post(browser_fixture_stop))
                .with_state(control_state),
        )
        .await
        .unwrap();
    });
    let info = json!({"pid":std::process::id(),"admin":format!("http://127.0.0.1:{admin_port}"),
        "business":format!("http://{}",std::net::SocketAddr::new(business_ip,business_port)),"control":format!("http://127.0.0.1:{control_port}"),
        "config_path":root,"canonical_config_path":canonical_root,"token_path":config_dir.join("state/admin-token"),
        "lifecycle":"test-only adapter reconstructs the real isolated RCC listener; installed services untouched"});
    std::fs::write(info_path, serde_json::to_vec_pretty(&info).unwrap()).unwrap();
    eprintln!("active-key browser fixture ready: admin={admin_port} business={business_port} control={control_port}");
    stopped.await.unwrap();
    if let Some(runtime) = control.runtime.lock().await.take() {
        browser_fixture_shutdown(runtime, &root).await;
    }
    for task in [upstream_task, admin_task, control_task] {
        task.abort();
        let _ = task.await;
    }
    wait_for_listener_address_close(std::net::SocketAddr::new(business_ip, business_port)).await;
    for port in [upstream_port, admin_port, control_port] {
        wait_for_listener_close(port).await;
    }
    eprintln!("active-key browser fixture cleanup: all owned ports closed; no installed lifecycle command used");
}
