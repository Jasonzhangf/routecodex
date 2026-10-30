//! Issue 6bd138a: content-part annotations carried by an intermediate provider
//! event must survive a closing `output_item.done` and the real public
//! `POST /v1/responses` Relay HTTP entry.
//!
//! The controlled upstream is shape-checking: it returns the annotation SSE
//! sequence only when the projected provider request carries the exact model,
//! stream intent and user input this case declares. Any other shape returns 400
//! and the captured request is printed by the failing test.
//!
//! Regression history: before the typed-tree fix, the closing item replaced the
//! reduced content part and dropped annotations that only the intermediate
//! content-part event carried.
//!
//! Run:
//! `CARGO_NET_OFFLINE=true CARGO_TARGET_DIR=/Volumes/Intel/playground/routecodex/6bd138a/v3/target-6bd138a node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server issue6bd138a_annotations::issue6bd138a_annotations_survive_public_http -- --nocapture --exact`

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const ANNOTATION_TEXT: &str = "cited text";
const PROMPT: &str = "6bd138a annotation fixture prompt";

fn annotation_value() -> Value {
    json!([{
        "type": "url_citation",
        "url": "https://example.com/6bd138a",
        "title": "cited"
    }])
}

#[derive(Clone)]
struct AnnotationPeer {
    attempts: Arc<AtomicUsize>,
    captures: mpsc::UnboundedSender<Value>,
}

fn annotation_fixture_shape(body: &Value) -> Result<(), String> {
    if body["model"] != json!("wire-test") {
        return Err(format!("provider model must project to wire-test: {body}"));
    }
    if body["stream"] != json!(true) {
        return Err(format!(
            "provider transport intent must be SSE for this case: {body}"
        ));
    }
    let input = body
        .get("input")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("provider input must be an array: {body}"))?;
    if input.len() != 1 {
        return Err(format!(
            "provider input must carry exactly one user message: {body}"
        ));
    }
    let message = &input[0];
    if message["type"] != json!("message") || message["role"] != json!("user") {
        return Err(format!(
            "provider input item must be one user message: {body}"
        ));
    }
    let content = &message["content"];
    let text_preserved = content == &json!(PROMPT)
        || content.as_array().is_some_and(|parts| {
            parts.len() == 1
                && parts[0]["type"] == json!("input_text")
                && parts[0]["text"] == json!(PROMPT)
        });
    if !text_preserved {
        return Err(format!(
            "provider input must preserve the exact user text {PROMPT:?}: {body}"
        ));
    }
    Ok(())
}

fn annotation_sse_response() -> Response {
    let item = json!({
        "id": "msg_6bd138a_annotations",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": ANNOTATION_TEXT}],
    });
    let completed = json!({
        "id": "resp_6bd138a_annotations",
        "object": "response",
        "status": "completed",
        "output": [item.clone()],
        "usage": {"input_tokens": 9, "output_tokens": 4, "total_tokens": 13},
    });
    let events = vec![
        json!({
            "type": "response.created",
            "response": {"id": "resp_6bd138a_annotations", "object": "response", "status": "in_progress", "output": []},
        }),
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {"id": "msg_6bd138a_annotations", "type": "message", "role": "assistant", "status": "in_progress", "content": []},
        }),
        json!({
            "type": "response.output_text.delta",
            "output_index": 0,
            "item_id": "msg_6bd138a_annotations",
            "content_index": 0,
            "delta": ANNOTATION_TEXT,
        }),
        json!({
            "type": "response.output_text.done",
            "output_index": 0,
            "item_id": "msg_6bd138a_annotations",
            "content_index": 0,
            "text": ANNOTATION_TEXT,
        }),
        json!({
            "type": "response.content_part.done",
            "output_index": 0,
            "item_id": "msg_6bd138a_annotations",
            "content_index": 0,
            "part": {
                "type": "output_text",
                "text": ANNOTATION_TEXT,
                "annotations": annotation_value(),
            },
        }),
        json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": item,
        }),
        json!({"type": "response.completed", "response": completed}),
    ];
    let mut wire = String::new();
    for event in events {
        wire.push_str(&format!(
            "event: {}\ndata: {}\n\n",
            event["type"].as_str().unwrap(),
            event
        ));
    }
    wire.push_str("data: [DONE]\n\n");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(wire))
        .unwrap()
}

async fn annotation_upstream(
    State(peer): State<AnnotationPeer>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    peer.attempts.fetch_add(1, Ordering::SeqCst);
    let _ = peer.captures.send(body.clone());
    match annotation_fixture_shape(&body) {
        Ok(()) => annotation_sse_response(),
        Err(reason) => Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "error": {
                        "message": format!("6bd138a annotation fixture shape mismatch: {reason}"),
                        "captured": body,
                    }
                })
                .to_string(),
            ))
            .unwrap(),
    }
}

#[tokio::test]
async fn issue6bd138a_annotations_survive_public_http() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "test-key-6bd138a");
    let _home_guard = TestHomeGuard::new("issue6bd138a-annotations");

    let attempts = Arc::new(AtomicUsize::new(0));
    let (captures_tx, mut captures) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = listener.local_addr().unwrap();
    let (upstream_shutdown, upstream_shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(annotation_upstream))
        .with_state(AnnotationPeer {
            attempts: attempts.clone(),
            captures: captures_tx,
        });
    let upstream_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = upstream_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let port = free_port();
    let mut manifest = responses_relay_provider_protocol_manifest(
        port,
        free_port(),
        &format!("http://{upstream_addr}/v1"),
        "responses",
        None,
    );
    manifest.debug.log_console = true;
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/v1/responses");
    let sent = client
        .post(&url)
        .json(&json!({
            "model": "client-test",
            "input": [{"type": "message", "role": "user", "content": PROMPT}],
            "stream": true,
        }))
        .send()
        .await;

    let capture = timeout(Duration::from_secs(10), captures.recv())
        .await
        .expect("the provider must receive one request before the client settles")
        .expect("provider capture channel must stay open");
    let attempts_seen = attempts.load(Ordering::SeqCst);

    let (status, wire) = match sent {
        Ok(response) => {
            let status = response.status();
            match response.text().await {
                Ok(wire) => (status, wire),
                Err(error) => panic!(
                    "client must receive the annotated business result, not a transport break: {error}; \
                     provider attempts={attempts_seen}; provider request={capture}"
                ),
            }
        }
        Err(error) => panic!(
            "client must receive the annotated business result, not a transport failure: {error}; \
             provider attempts={attempts_seen}; provider request={capture}"
        ),
    };

    assert_eq!(
        status,
        StatusCode::OK,
        "public Responses entry must accept the annotation case; wire={wire}; provider request={capture}"
    );

    let mut done_items: Vec<Value> = Vec::new();
    let mut completed_frames = 0usize;
    let mut terminal: Option<Value> = None;
    for line in wire.lines() {
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        if data.trim() == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(data).unwrap_or_else(|error| {
            panic!("client SSE data must be JSON ({error}): {line}; wire={wire}")
        });
        let event_type = event["type"].as_str().unwrap_or_default();
        assert!(
            !matches!(event_type, "response.failed" | "response.error" | "error"),
            "provider error payload must not reach the client: {event}; wire={wire}"
        );
        if event_type == "response.output_item.done" {
            done_items.push(event["item"].clone());
        }
        if event_type == "response.completed" {
            completed_frames += 1;
            terminal = Some(event["response"].clone());
        }
    }

    assert_eq!(
        done_items.len(),
        1,
        "client must receive one completed output item: wire={wire}; provider request={capture}"
    );
    let done_content = &done_items[0]["content"][0];
    assert_eq!(
        done_content["type"], "output_text",
        "the annotated item must keep its output_text part: wire={wire}"
    );
    assert_eq!(
        done_content["text"], ANNOTATION_TEXT,
        "the annotated item text must be complete: wire={wire}"
    );
    assert_eq!(
        done_content["annotations"],
        annotation_value(),
        "output_item.done must keep annotations that only the intermediate content part carried: wire={wire}"
    );

    assert_eq!(
        completed_frames, 1,
        "client must receive exactly one normal terminal: wire={wire}"
    );
    let terminal = terminal.unwrap_or_else(|| {
        panic!("client must receive response.completed; wire={wire}; provider request={capture}")
    });
    assert_eq!(terminal["status"], "completed", "{terminal}");
    let terminal_content = &terminal["output"][0]["content"][0];
    assert_eq!(
        terminal_content["type"], "output_text",
        "terminal output must carry the output_text part: {terminal}"
    );
    assert_eq!(
        terminal_content["text"], ANNOTATION_TEXT,
        "terminal output must carry the complete text: {terminal}"
    );
    assert_eq!(
        terminal_content["annotations"],
        annotation_value(),
        "terminal output must keep annotations omitted by the provider terminal: {terminal}"
    );
    assert_eq!(
        attempts_seen, 1,
        "the annotation case is one real business attempt and must not be retried; provider request={capture}"
    );

    handle.shutdown().await;
    let _ = upstream_shutdown.send(());
    upstream_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
}
