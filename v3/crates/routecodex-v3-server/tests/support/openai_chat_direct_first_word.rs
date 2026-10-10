//! Additional timing cases share the existing actual Chat Direct fixture.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::time::{sleep, timeout, Instant};

static TERMINAL_SENT: AtomicBool = AtomicBool::new(false);

pub(super) async fn controlled_response(body: &Value) -> Option<Response<Body>> {
    let case = body.pointer("/messages/0/content")?.as_str()?;
    if case == "first-word-slow-json" {
        sleep(Duration::from_millis(600)).await;
        return None;
    }
    if !matches!(case, "first-word-late" | "first-word-pause") {
        return None;
    }
    assert_eq!(
        body["stream"], true,
        "SSE timing peer requires actual SSE wire intent"
    );
    let late = case == "first-word-late";
    let stream = futures_util::stream::unfold(0_u8, move |step| async move {
        let (delta, finish) = match step {
            0 => (json!({"role":"assistant","content":""}), None),
            1 => {
                sleep(Duration::from_millis(if late { 600 } else { 20 })).await;
                (json!({"content":"GENERIC_DIRECT_FIRST_WORD"}), None)
            }
            2 => {
                sleep(Duration::from_millis(600)).await;
                TERMINAL_SENT.store(true, Ordering::Release);
                (json!({}), Some("stop"))
            }
            _ => return None,
        };
        let frame = json!({"id":"chatcmpl-first-word","object":"chat.completion.chunk",
            "model":"chat-wire-model","choices":[{"index":0,"delta":delta,"finish_reason":finish}]});
        let mut bytes = format!("data: {frame}\n\n");
        if finish.is_some() {
            bytes.push_str("data: [DONE]\n\n");
        }
        Some((
            Ok::<_, std::convert::Infallible>(bytes.into_bytes()),
            step + 1,
        ))
    });
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap(),
    )
}

struct RecordsDir(std::path::PathBuf);
impl Drop for RecordsDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn generic_direct_uses_published_first_word_and_preserves_json_header_policy() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_OPENAI_CHAT_CONTROLLED_KEY", "controlled-secret");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream.local_addr().unwrap().port();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(controlled_openai_chat_upstream),
        )
        .with_state(Arc::new(ProviderState {
            captures: captures_tx,
        }));
    let peer = tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let records_dir = RecordsDir(std::env::temp_dir().join(format!(
        "rcc-generic-direct-first-word-{}-{}",
        std::process::id(),
        free_port()
    )));
    std::fs::create_dir_all(&records_dir.0).unwrap();
    let port = free_port();
    let mut candidate = manifest_with_policy(
        port,
        upstream_port,
        None,
        "request_timeout_ms = 2000\nsse_first_frame_timeout_ms = 500",
    );
    candidate.debug.log_file = Some(records_dir.0.join("first-word.log").display().to_string());
    let handle = spawn_v3_server_aggregate(candidate).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let records_path = records_dir
        .0
        .join(format!("server-v3-{port}.request-records.jsonl"));
    let mut last_request_id = String::new();

    // The negative case is last so its exact-identity cooldown cannot affect success cases.
    for case in [
        "first-word-slow-json",
        "first-word-pause",
        "first-word-late",
    ] {
        let streaming = case != "first-word-slow-json";
        TERMINAL_SENT.store(false, Ordering::Release);
        let started = Instant::now();
        let response = client
            .post(&endpoint)
            .json(&json!({
                "model":"controlled.chat-wire-model",
                "messages":[{"role":"user","content":case}], "stream":streaming
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            }
        );
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        let mut failed = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    if streaming && chunk.windows(5).any(|part| part == b"data:") {
                        assert!(
                            TERMINAL_SENT.load(Ordering::Acquire),
                            "provider bytes escaped before actual terminal"
                        );
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Err(error) => {
                    assert!(
                        !error.is_timeout() && (error.is_body() || error.is_decode()),
                        "must be actual request transport failure, not test timeout: {error}"
                    );
                    failed = true;
                    break;
                }
            }
        }
        let elapsed = started.elapsed();
        let body = String::from_utf8(bytes).unwrap();
        let capture = captures_rx.recv().await.unwrap();
        assert_eq!(capture.body["model"], "chat-wire-model");
        assert_eq!(capture.body["messages"][0]["content"], case);
        assert_eq!(capture.body["stream"], streaming);
        assert_eq!(
            capture.accept.as_deref(),
            Some(if streaming {
                "text/event-stream"
            } else {
                "application/json"
            })
        );
        let event = if failed {
            "request.provider_attempt_failed"
        } else {
            "request.completed"
        };
        let record = timeout(Duration::from_secs(1), async {
            loop {
                let records = std::fs::read_to_string(&records_path).unwrap_or_default();
                if let Some(record) = records
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .filter(|record| record["row"]["event_type"] == event)
                    .last()
                {
                    let request_id = record["row"]["meta"]["request_id"]
                        .as_str()
                        .unwrap()
                        .to_string();
                    if request_id != last_request_id {
                        break (record, request_id);
                    }
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("actual Direct request must publish its real observation");
        last_request_id = record.1;
        let meta = &record.0["row"]["meta"];
        assert_eq!(meta["execution_mode"], "direct");
        assert_eq!(meta["entry_protocol"], "openai_chat");
        assert_eq!(meta["provider_id"], "controlled");
        assert_eq!(meta["auth_alias"], "controlled");
        assert_eq!(meta["model"], "chat-wire-model");
        assert_eq!(meta["wire_model"], "chat-wire-model");
        if case == "first-word-late" {
            // The generic Direct response-projection preflight failure sink
            // currently labels its attempt record "json" (v3_direct_core.rs).
            // Actual client and provider HTTP headers and wire stream intent
            // above establish SSE; this diagnostic label does not change it.
            assert_eq!(
                record.0["row"]["event_type"],
                "request.provider_attempt_failed"
            );
            assert_eq!(meta["transport"], "json");
            assert!(
                failed,
                "configured500ms must reject role-only+600ms late first word"
            );
            assert!(
                elapsed >= Duration::from_millis(400) && elapsed < Duration::from_millis(800),
                "first-word deadline was reset: {elapsed:?}"
            );
            assert!(meta["error_detail"]
                .as_str()
                .unwrap()
                .contains("semantic first frame within timeout"));
            assert!(!body.contains("GENERIC_DIRECT_FIRST_WORD") && !body.contains("[DONE]"));
        } else {
            assert_eq!(meta["transport"], if streaming { "sse" } else { "json" });
            assert!(!failed, "timely request failed: {body}");
            assert!(
                elapsed >= Duration::from_millis(600),
                "600ms wait was not exercised: {elapsed:?}"
            );
            if streaming {
                assert!(body.contains("GENERIC_DIRECT_FIRST_WORD") && body.contains("[DONE]"));
            } else {
                let json: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(json["choices"][0]["message"]["content"], "controlled json");
            }
        }
        eprintln!("GENERIC_DIRECT_FIRST_WORD case={case} configured_ms=500 elapsed_ms={} failed={failed} record={}", elapsed.as_millis(), record.0);
    }
    handle.shutdown().await;
    drop(client);
    let _ = shutdown_tx.send(());
    peer.await.unwrap();
    std::env::remove_var("V3_OPENAI_CHAT_CONTROLLED_KEY");
}
