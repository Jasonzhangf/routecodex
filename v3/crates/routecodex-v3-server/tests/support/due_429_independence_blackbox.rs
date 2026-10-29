use super::*;
use super::pool_empty_recovery_blackbox::use_native_direct_responses;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue44cc3af_relay_due_429_does_not_serialize_requests() {
    assert_due_429_requests_are_independent(false, 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue44cc3af_direct_due_429_does_not_serialize_requests() {
    assert_due_429_requests_are_independent(true, 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue44cc3af_relay_due_429_respects_shared_limit() {
    assert_due_429_requests_are_independent(false, 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issue44cc3af_direct_due_429_respects_shared_limit() {
    assert_due_429_requests_are_independent(true, 1).await;
}

async fn assert_due_429_requests_are_independent(direct: bool, max_in_flight: u32) {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("44cc3af-independent-due-429");
    std::env::set_var("V3_P6_TEST_KEY", "test-key");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (hit_tx, mut hits) = mpsc::unbounded_channel();
    let app = Router::new().route("/v1/responses", post({
        let calls = calls.clone();
        let release = release.clone();
        move |axum::Json(_body): axum::Json<Value>| {
            let calls = calls.clone();
            let release = release.clone();
            let hit_tx = hit_tx.clone();
            async move {
                let call = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if call == 0 {
                    return Response::builder().status(429)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"error":{"type":"rate_limit_error","message":"capacity busy"}}"#)).unwrap();
                }
                let _ = hit_tx.send(call);
                release.acquire().await.unwrap().forget();
                Response::builder().status(200).header("content-type", "text/event-stream")
                    .body(Body::from("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"independent\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"independent result\"}],\"output_text\":\"independent result\"}}\n\ndata: [DONE]\n\n")).unwrap()
            }
        }
    }));
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let url = format!("http://{addr}/v1");
    let mut manifest = concurrency_switch_manifest(&url, &url);
    let first_id = format!("concurrency_first_{}", manifest.servers["a"].port);
    manifest.providers.get_mut(&first_id).unwrap().concurrency.as_mut().unwrap().max_in_flight = max_in_flight;
    if direct { use_native_direct_responses(&mut manifest); }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let model = format!("{first_id}.test");
    let request = |session: &'static str| {
        let endpoint = endpoint.clone();
        let model = model.clone();
        tokio::spawn(async move {
            reqwest::Client::new().post(endpoint).header("session-id", session)
                .json(&json!({"model":model,"input":"independent","stream":true}))
                .send().await.unwrap().text().await.unwrap()
        })
    };
    let first = request("due-first");
    timeout(Duration::from_secs(15), hits.recv()).await
        .expect("first request never reached the due recovery attempt").unwrap();
    let second = request("due-second");
    let second_hit = timeout(Duration::from_secs(3), hits.recv()).await;
    if max_in_flight == 1 {
        assert!(second_hit.is_err(), "second request exceeded the shared capacity limit");
        release.add_permits(1);
        timeout(Duration::from_secs(15), hits.recv()).await
            .expect("second request did not start after capacity was released").unwrap();
        release.add_permits(1);
    } else {
        release.add_permits(2);
        assert!(second_hit.is_ok(), "second request waited for the first request's held recovery attempt");
    }
    for task in [first, second] {
        let body = timeout(Duration::from_secs(15), task).await.unwrap().unwrap();
        assert_responses_sse_delivered_business_text(&body, "independent result");
    }
    handle.shutdown().await;
    upstream.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
}
