use super::*;

#[path = "../../tests/local599_consumer_blackbox.rs"]
mod fixture;

/// Compose the real public Runtime consumer with the production Server output
/// and transport boundary, then read the result through a real HTTP client.
#[tokio::test]
async fn local599_server_projection_aborts_real_consumer_and_preserves_healthy_control() {
    for fail in [false, true] {
        let output = fixture::output_for_server(fail).await;
        let log =
            std::env::temp_dir().join(format!("rcc-local599-server-{}.log", std::process::id()));
        let state = test_v3_listener_state_with_debug(&log, 5555, false, false, None, false);
        let output = Arc::new(tokio::sync::Mutex::new(Some(output)));
        let router = axum::Router::new().route(
            "/v1/responses",
            axum::routing::post(move || {
                let state = state.clone();
                let output = output.clone();
                async move {
                    let output = output.lock().await.take().expect("single consumer request");
                    let response = responses_relay_output_response(output, None, None, true);
                    commit_model_transport_outcome(&state, None, response)
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            reqwest::Client::new()
                .post(format!("http://{addr}/v1/responses"))
                .send(),
        )
        .await
        .expect("Server transport must settle");
        if fail {
            if let Ok(mut response) = response {
                assert_eq!(response.status().as_u16(), 200);
                let mut body = Vec::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                        Err(_) => break,
                        Ok(None) => panic!("599 must not end as a successful empty transfer"),
                    }
                }
                let body = String::from_utf8(body).unwrap();
                assert!(
                    !body.contains("response.completed")
                        && !body.contains("\"error\"")
                        && !body.contains("599")
                        && !body.contains("local599 controlled"),
                    "{body}"
                );
            }
        } else {
            let body = response.unwrap().text().await.unwrap();
            assert!(
                body.contains("local599 controlled response")
                    && body.contains("response.completed"),
                "{body}"
            );
        }
        let _ = stop.send(());
        server.await.unwrap();
    }
}
