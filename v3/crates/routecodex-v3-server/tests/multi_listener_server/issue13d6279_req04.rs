use super::*;
use axum::Json;

// Stable public-entry regression: Responses Relay must preserve trimmed and
// cross-turn custom history before its first provider attempt.
#[tokio::test]
async fn issue13d6279_responses_custom_history_roundtrip() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_P6_TEST_KEY", "req04-controlled");
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", upstream.local_addr().unwrap());
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let app = Router::new()
        .route("/v1/responses", post(shape_checking_upstream))
        .with_state(tx);
    let upstream_task = tokio::spawn(async move { axum::serve(upstream, app).await.unwrap() });
    let handle = spawn_v3_server_aggregate(responses_relay_manifest(
        free_port(),
        free_port(),
        &base_url,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let tools = json!([{"type":"custom","name":"lookup","format":{"type":"text"}}]);
    let mut history = json!([
        {"type":"function_call_output","call_id":"trimmed-call","output":"prior failure\r\nunchanged"},
        {"type":"custom_tool_call","id":"ctc-old","call_id":"custom-old","name":"lookup","input":"{broken"},
        {"type":"message","role":"assistant","content":[{"type":"output_text","text":"intervening assistant"}]},
        {"type":"custom_tool_call_output","call_id":"custom-old","output":"client error: invalid JSON"}
    ]);
    let first: Value = client
        .post(&endpoint)
        .json(&json!({
            "model":"client-test", "input":history, "tools":tools, "stream":false
        }))
        .send()
        .await
        .unwrap_or_else(|error| {
            panic!(
                "Responses request failed: {error}; captured provider shape: {:?}",
                rx.try_recv()
            )
        })
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let captured = timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(valid_history(&captured), "provider shape: {captured}");
    assert!(
        rx.try_recv().is_err(),
        "first request must use exactly one attempt"
    );
    let call = first["output"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "custom_tool_call")
        .expect("custom call returned")
        .clone();
    assert_eq!(call["call_id"], "custom-next");
    assert_eq!(call["name"], "lookup");
    assert_eq!(call["input"], "{invalid");
    let error = serde_json::from_str::<Value>(call["input"].as_str().unwrap()).unwrap_err();
    let receipt = format!("client tool error: {error}");
    history.as_array_mut().unwrap().extend([
        call,
        json!({"type":"custom_tool_call_output","call_id":"custom-next","output":receipt}),
    ]);
    let second: Value = client
        .post(&endpoint)
        .json(&json!({
            "model":"client-test", "input":history, "tools":tools, "stream":false
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(second["status"], "completed");
    assert!(second["output"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["content"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(|part| part["text"] == "corrected"))));
    let captured = timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(valid_history(&captured), "followup shape: {captured}");
    assert!(captured["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["type"] == "custom_tool_call_output"
            && item["call_id"] == "custom-next"
            && item["output"] == receipt));
    assert!(
        rx.try_recv().is_err(),
        "followup must use exactly one attempt"
    );
    handle.shutdown().await;
    upstream_task.abort();
    std::env::remove_var("V3_P6_TEST_KEY");
}

fn valid_history(body: &Value) -> bool {
    let Some(input) = body["input"].as_array() else {
        return false;
    };
    let old_call = input.iter().position(|item| {
        item["type"] == "custom_tool_call"
            && item["call_id"] == "custom-old"
            && item["name"] == "lookup"
            && item["input"] == "{broken"
    });
    let intervening = input.iter().position(|item| {
        item["role"] == "assistant"
            && item["content"].as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part["text"] == "intervening assistant")
            })
    });
    let old_output = input.iter().position(|item| {
        item["type"] == "custom_tool_call_output"
            && item["call_id"] == "custom-old"
            && item["output"] == "client error: invalid JSON"
    });
    matches!((old_call, intervening, old_output), (Some(a), Some(b), Some(c)) if a < b && b < c)
        && input.iter().any(|item| {
            item["type"] == "function_call_output"
                && item["call_id"] == "trimmed-call"
                && item["output"] == "prior failure\r\nunchanged"
        })
        && body["tools"].as_array().is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool["type"] == "custom"
                    && tool["name"] == "lookup"
                    && tool["format"]["type"] == "text"
            })
        })
}

async fn shape_checking_upstream(
    State(tx): State<mpsc::UnboundedSender<Value>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    tx.send(body.clone()).unwrap();
    let followup = body["input"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["call_id"] == "custom-next"));
    let paired = !followup
        || body["input"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["type"] == "custom_tool_call"
                    && item["call_id"] == "custom-next"
                    && item["name"] == "lookup"
                    && item["input"] == "{invalid"
            }) && items.iter().any(|item| {
                item["type"] == "custom_tool_call_output"
                    && item["call_id"] == "custom-next"
                    && item["output"]
                        .as_str()
                        .is_some_and(|text| text.starts_with("client tool error:"))
            })
        });
    if !valid_history(&body) || !paired {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Body::from("Req04 changed provider history shape"))
            .unwrap();
    }
    let output = if followup {
        json!([{"type":"message","id":"msg-corrected","role":"assistant","status":"completed","content":[{"type":"output_text","text":"corrected","annotations":[]}]}])
    } else {
        json!([{"type":"custom_tool_call","id":"ctc-next","call_id":"custom-next","name":"lookup","input":"{invalid","status":"completed"}])
    };
    let event = json!({"type":"response.completed","response":{"id":"resp-req04","object":"response","model":"wire-test","status":"completed","output":output}});
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(format!(
            "event: response.completed\ndata: {event}\n\n"
        )))
        .unwrap()
}
