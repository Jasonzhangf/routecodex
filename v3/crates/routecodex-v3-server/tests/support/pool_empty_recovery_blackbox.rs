use super::*;

#[derive(Clone)]
struct FirstByteStallState {
    captures: tokio::sync::mpsc::UnboundedSender<ProviderCapture>,
    release: Arc<Semaphore>,
}

async fn stalled_before_first_byte_responses_upstream(
    State(state): State<Arc<FirstByteStallState>>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> Response<Body> {
    let _ = state
        .captures
        .send(ProviderCapture::from_http(&headers, body));
    let _permit = Arc::clone(&state.release).acquire_owned().await.unwrap();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(
            "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stalled\",\"status\":\"in_progress\"}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stalled\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"stalled provider released\"}]}]}}\n\ndata: [DONE]\n\n",
        ))
        .unwrap()
}

async fn start_first_byte_stalled_upstream() -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<ProviderCapture>,
    Arc<Semaphore>,
    oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = tokio::sync::mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(
            "/v1/responses",
            post(stalled_before_first_byte_responses_upstream),
        )
        .with_state(Arc::new(FirstByteStallState {
            captures: captures_tx,
            release: Arc::clone(&release),
        }));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (
        format!("http://{address}/v1"),
        captures_rx,
        release,
        shutdown_tx,
    )
}

pub(super) fn use_native_direct_responses(
    manifest: &mut routecodex_v3_config::V3Config05ManifestPublished,
) {
    for provider in manifest.providers.values_mut() {
        provider
            .responses
            .as_mut()
            .expect("fixture declares Responses")
            .process = "direct".into();
        for interface in provider.interfaces.values_mut() {
            interface
                .responses
                .as_mut()
                .expect("compiled interface declares Responses")
                .process = "direct".into();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue44cc3af_first_byte_stall_keeps_sibling_requests_independent() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-first-byte-stall");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let (stalled_url, mut stalled_requests, _stalled_release, stalled_shutdown) =
        start_first_byte_stalled_upstream().await;
    let (healthy_url, mut healthy_requests, healthy_shutdown) = start_controlled_upstream().await;
    let mut manifest = concurrency_switch_manifest(&stalled_url, &healthy_url);
    use_native_direct_responses(&mut manifest);
    let ids: Vec<String> = manifest.providers.keys().cloned().collect();
    let stalled_id = ids[0].clone();
    let healthy_id = ids[1].clone();
    {
        let stalled = manifest.providers.get_mut(&stalled_id).unwrap();
        stalled.request_timeout_ms = 400;
        stalled.sse_first_frame_timeout_ms = Some(400);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let endpoint = format!("{base}/v1/responses");
    let stalled_client = client.clone();
    let stalled_endpoint = endpoint.clone();
    let mut stalled = tokio::spawn(async move {
        stalled_client
            .post(stalled_endpoint)
            .header("session-id", "first-byte-stall")
            .json(&json!({"model":"client-test","input":"stalled","stream":true}))
            .send()
            .await
    });
    timeout(Duration::from_secs(2), stalled_requests.recv())
        .await
        .expect("the stalled provider must receive the first request")
        .unwrap();
    assert!(
        timeout(Duration::from_millis(100), &mut stalled)
            .await
            .is_err(),
        "the stalled provider must leave its request pending before the budget expires"
    );
    let started = std::time::Instant::now();
    let healthy = client
        .post(&endpoint)
        .header("session-id", "first-byte-stall")
        .json(&json!({"model":format!("{healthy_id}.test"),"input":"independent","stream":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(healthy.status(), StatusCode::OK);
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "a stalled provider must not delay a request served by a healthy provider: {:?}",
        started.elapsed()
    );
    assert_responses_sse_delivered_business_text(
        &healthy.text().await.unwrap(),
        "controlled SSE response",
    );
    assert!(
        !stalled.is_finished(),
        "the stalled request must still be waiting while the sibling completes"
    );
    let stalled_response = timeout(Duration::from_secs(3), stalled)
        .await
        .expect("the stalled candidate must time out into the next candidate")
        .unwrap()
        .unwrap();
    assert_eq!(stalled_response.status(), StatusCode::OK);
    assert_responses_sse_delivered_business_text(
        &stalled_response.text().await.unwrap(),
        "controlled SSE response",
    );
    timeout(Duration::from_secs(2), healthy_requests.recv())
        .await
        .expect("the healthy provider must receive the independent request")
        .unwrap();
    timeout(Duration::from_secs(2), healthy_requests.recv())
        .await
        .expect("the timed-out candidate must reselect onto the healthy provider")
        .unwrap();
    assert!(
        stalled_requests.try_recv().is_err(),
        "the stalled candidate must not receive repeated concurrent attempts"
    );
    timeout(Duration::from_secs(2), handle.shutdown())
        .await
        .expect("a stalled provider must not block server shutdown");
    stalled_shutdown.send(()).unwrap();
    healthy_shutdown.send(()).unwrap();
    std::env::remove_var("V3_P6_TEST_KEY");
}
