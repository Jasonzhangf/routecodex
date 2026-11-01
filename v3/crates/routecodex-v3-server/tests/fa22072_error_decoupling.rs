//! fa22072 three-source public boundary and release evidence. These cases fill
//! request/WS/release gaps; existing controlled tests cover business semantics.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{mpsc, oneshot},
    time::timeout,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

struct Peer {
    captures: mpsc::UnboundedSender<Value>,
}
fn completed() -> Value {
    json!({"id":"resp_owned","object":"response","status":"completed","model":"wire-owned","output":[{"id":"msg_owned","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"business error word survives","annotations":[]}]}]})
}
async fn upstream(State(peer): State<Arc<Peer>>, Json(body): Json<Value>) -> Response<Body> {
    peer.captures.send(body.clone()).unwrap();
    let input = body["input"].to_string();
    let (status, media, bytes) =
        if input.contains("provider-failure") && body["model"] != "wire-recover" {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "application/json",
                r#"{"error":{"message":"owned private provider cause"}}"#.to_owned(),
            )
        } else if input.contains("response-failure") {
            (
                StatusCode::OK,
                "text/event-stream",
                "data: {unparseable-json}\n\n".to_owned(),
            )
        } else {
            (
                StatusCode::OK,
                "text/event-stream",
                format!(
                    "event: response.completed\ndata: {}\n\n",
                    json!({"type":"response.completed","response":completed()})
                ),
            )
        };
    Response::builder()
        .status(status)
        .header("content-type", media)
        .body(Body::from(bytes))
        .unwrap()
}
struct Entry {
    handle: V3ServerAggregateHandle,
    captures: mpsc::UnboundedReceiver<Value>,
    shutdown: oneshot::Sender<()>,
    peer: tokio::task::JoinHandle<()>,
}
impl Entry {
    fn base(&self) -> String {
        format!("http://{}", self.handle.listeners[0].addr)
    }
    async fn stop(self) {
        assert!(self.handle.shutdown().await.is_empty());
        self.shutdown.send(()).unwrap();
        timeout(Duration::from_secs(5), self.peer)
            .await
            .unwrap()
            .unwrap();
        std::env::remove_var("FA22072_BOUNDARY_KEY");
    }
}
async fn start(process: &str, recovery: bool) -> Entry {
    std::env::set_var("FA22072_BOUNDARY_KEY", "owned-fixture-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = listener.local_addr().unwrap();
    let (captures, rx) = mpsc::unbounded_channel();
    let (shutdown, stop) = oneshot::channel();
    let peer = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/responses", post(upstream))
                .with_state(Arc::new(Peer { captures })),
        )
        .with_graceful_shutdown(async {
            let _ = stop.await;
        })
        .await
        .unwrap();
    });
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("owned");
    let port = test_ports::free_port();
    let targets = if recovery {
        r#"[{kind="provider_model",provider="test",model="test",key="key",priority=2},{kind="provider_model",provider="test",model="recover",key="key",priority=1}]"#
    } else {
        r#"[{kind="provider_model",provider="test",model="test",key="key",priority=1}]"#
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses", "openai_chat", "anthropic", "gemini"]
{execution}
[providers.test]
type = "responses"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{type="api_key",entries=[{{alias="key",env="FA22072_BOUNDARY_KEY"}}]}}
health = {{enabled=false,failure_threshold=1,cooldown_ms=5000}}
responses = {{process="{process}",streaming="always"}}
[providers.test.models.test]
wire_name = "wire-owned"
capabilities = ["text","tools"]
supports_streaming = true
[providers.test.models.recover]
wire_name = "wire-recover"
capabilities = ["text","tools"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{strategy="priority"}}
targets = {targets}
[debug]
log_console = false
snapshots = true
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    Entry {
        handle: spawn_v3_server_aggregate(manifest).await.unwrap(),
        captures: rx,
        shutdown,
        peer,
    }
}
async fn raw(entry: &Entry, path: &str, header: &str, body: &str) -> Vec<u8> {
    let mut socket = TcpStream::connect(entry.handle.listeners[0].addr)
        .await
        .unwrap();
    socket.write_all(format!("POST {path} HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: owned-failure\r\nConnection: close\r\n{header}\r\n{body}").as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    let ended = timeout(Duration::from_secs(5), socket.read_to_end(&mut bytes))
        .await
        .expect("request must terminate");
    assert!(
        ended.is_ok()
            || ended
                .as_ref()
                .is_err_and(|e| e.kind() == std::io::ErrorKind::ConnectionReset)
    );
    eprintln!(
        "public-wire path={path} received={} bytes={}",
        bytes.len(),
        String::from_utf8_lossy(&bytes)
    );
    bytes
}
async fn drained(entry: &Entry) {
    // This public maintenance preparation waits for actual activity/admission
    // permits. It neither execs nor restarts the listener; dropping resumes it.
    let preparation = timeout(Duration::from_secs(5), entry.handle.prepare_exec_attempt())
        .await
        .expect("failed request leaked activity/lease")
        .unwrap();
    drop(preparation);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .post(format!("{}/v1/responses", entry.base()))
        .header("x-session-id", "owned-failure")
        .json(&json!({"model":"test.test","input":"sibling success","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.text().await.unwrap();
    assert!(
        bytes.contains("business error word survives") && bytes.contains("response.completed"),
        "{bytes}"
    );
    eprintln!("release-public maintenance=drained sibling=business-completed");
}

async fn internal_chain_receipt(entry: &Entry, origin: &str) {
    let logs: Value = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("{}/_routecodex/debug/logs", entry.base()))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let nodes = logs["logs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|event| event["node_id"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    eprintln!("internal-chain origin={origin} nodes={nodes:?}");
    let chains = logs["logs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["node_id"] == "V3Error06ClientProjected")
        .map(|event| &event["details"]["error_chain"])
        .collect::<Vec<_>>();
    eprintln!("internal-chain origin={origin} chains={chains:?}");
    assert!(
        chains.iter().any(|chain| {
            chain.as_array().is_some_and(|nodes| {
                nodes.len() == 6
                    && nodes.first() == Some(&json!("V3Error01SourceRaised"))
                    && nodes.last() == Some(&json!("V3Error06ClientProjected"))
            })
        }),
        "the public diagnostic must retain the typed failure chain"
    );
}

#[tokio::test]
async fn request_sources_abort_without_bytes_and_release_activity() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start("chat", false).await;
    for path in [
        "/v1/responses",
        "/v1/chat/completions",
        "/v1/messages",
        "/v1beta/models/wire-owned/generateContent",
    ] {
        assert!(raw(&entry, path, "Content-Length: invalid\r\n", "")
            .await
            .is_empty());
        assert!(raw(
            &entry,
            path,
            "Content-Type: application/json\r\nContent-Length: 1\r\n",
            "{"
        )
        .await
        .is_empty());
    }
    let body = json!({"model":"test.test","input":"request stage","previous_response_id":"retired_id","stream":false}).to_string();
    assert!(raw(
        &entry,
        "/v1/responses",
        &format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ),
        &body
    )
    .await
    .is_empty());
    assert!(
        entry.captures.try_recv().is_err(),
        "request failures must precede provider execution"
    );
    internal_chain_receipt(&entry, "request").await;
    drained(&entry).await;
    entry.stop().await;
}

#[tokio::test]
async fn response_decode_failure_aborts_json_and_sse_and_releases_activity() {
    let _guard = TEST_LOCK.lock().await;
    for process in ["direct", "chat"] {
        let mut entry = start(process, false).await;
        for stream in [false, true] {
            let body =
                json!({"model":"test.test","input":"response-failure","stream":stream}).to_string();
            let wire = raw(
                &entry,
                "/v1/responses",
                &format!(
                    "Content-Type: application/json\r\nContent-Length: {}\r\n",
                    body.len()
                ),
                &body,
            )
            .await;
            assert!(entry.captures.try_recv().is_ok());
            if !stream {
                assert!(wire.is_empty());
            } else if !wire.is_empty() {
                let text = String::from_utf8_lossy(&wire);
                assert!(text.starts_with("HTTP/1.1 200") && text.contains("text/event-stream"));
                assert!(
                    !text.contains("data:")
                        && !text.contains("event:")
                        && !text.contains("[DONE]")
                        && !wire.ends_with(b"0\r\n\r\n")
                );
            }
            internal_chain_receipt(&entry, "response").await;
            drained(&entry).await;
            entry.captures.recv().await.unwrap();
        }
        entry.stop().await;
    }
}

#[tokio::test]
async fn websocket_three_sources_close_without_business_or_error_frames_and_release() {
    let _guard = TEST_LOCK.lock().await;
    for process in ["direct", "chat"] {
        let mut entry = start(process, false).await;
        for input in ["malformed-request", "response-failure", "provider-failure"] {
            let mut request = format!("ws://{}/v1/responses", entry.handle.listeners[0].addr)
                .into_client_request()
                .unwrap();
            request.headers_mut().insert(
                "openai-beta",
                "responses_websockets=2026-02-06".parse().unwrap(),
            );
            request
                .headers_mut()
                .insert("x-session-id", "owned-failure".parse().unwrap());
            let (mut socket, _) = connect_async(request).await.unwrap();
            let event = if input == "malformed-request" {
                "{".to_owned()
            } else {
                json!({"type":"response.create","model":"test.test","input":input,"stream":true})
                    .to_string()
            };
            socket.send(Message::Text(event)).await.unwrap();
            let terminal = timeout(Duration::from_secs(5), socket.next())
                .await
                .expect("WS failure must terminate");
            assert!(
                matches!(terminal, None | Some(Err(_)) | Some(Ok(Message::Close(_)))),
                "WS leaked frame: {terminal:?}"
            );
            eprintln!("public-ws process={process} source={input} terminal={terminal:?}");
            if input == "malformed-request" {
                assert!(entry.captures.try_recv().is_err());
            } else {
                entry.captures.recv().await.unwrap();
            }
            drop(socket);
            drained(&entry).await;
            entry.captures.recv().await.unwrap();
        }
        entry.stop().await;
    }
}

#[tokio::test]
async fn provider_http_failure_recovers_before_client_business_commit() {
    let _guard = TEST_LOCK.lock().await;
    let mut entry = start("chat", true).await;
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
        .post(format!("{}/v1/responses", entry.base()))
        .json(&json!({"input":"provider-failure","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.text().await.unwrap();
    assert!(
        bytes.contains("business error word survives")
            && !bytes.contains("owned private provider cause")
    );
    // The two real business attempts are the failed wire-owned attempt and the
    // recovering wire-recover attempt. During the mandated flat multi-identity
    // hold (`req-20261027-single-identity-recovery`) the probe scheduler may
    // emit a health probe for the failed identity, so drain any observation
    // frames until the wire-recover business attempt arrives.
    let first = entry.captures.recv().await.unwrap();
    assert_eq!(first["model"], "wire-owned");
    let mut saw_recover = false;
    for _ in 0..8 {
        let capture = entry.captures.recv().await.unwrap();
        if capture["model"] == "wire-recover" {
            saw_recover = true;
            break;
        }
    }
    assert!(saw_recover, "wire-recover business attempt must follow");
    eprintln!("public-recovery attempts=2 client={bytes}");
    drained(&entry).await;
    entry.stop().await;
}

#[tokio::test]
async fn three_failed_requests_do_not_block_concurrent_or_same_identity_followup() {
    let _guard = TEST_LOCK.lock().await;
    for origin in ["request", "response-failure", "provider-failure"] {
        let mut entry = start("chat", false).await;
        let mut failed = json!({"model":"test.test","input":origin,"stream":false});
        if origin == "request" {
            failed["previous_response_id"] = json!("retired_id");
        }
        let failed = failed.to_string();
        let headers = format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            failed.len()
        );
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let sibling = async {
            let response = client
                .post(format!("{}/v1/responses", entry.base()))
                .header("x-session-id", "owned-sibling")
                .json(&json!({"model":"test.test","input":"concurrent sibling","stream":true}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response.text().await.unwrap();
            assert!(
                body.contains("business error word survives")
                    && body.contains("response.completed")
            );
        };
        let (wire, ()) = tokio::join!(raw(&entry, "/v1/responses", &headers, &failed), sibling);
        assert!(
            wire.is_empty(),
            "JSON failure must close before any HTTP head"
        );
        let expected_attempts = if origin == "request" { 1 } else { 2 };
        for _ in 0..expected_attempts {
            entry.captures.try_recv().unwrap();
        }
        assert!(entry.captures.try_recv().is_err());
        drained(&entry).await;
        eprintln!("isolation-public origin={origin} concurrent=completed same-identity-followup=completed");
        entry.stop().await;
    }
}
