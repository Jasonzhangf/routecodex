use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{net::TcpListener, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

async fn provider(
    State(captured): State<Arc<Mutex<Vec<Value>>>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    captured.lock().await.push(body.clone());
    if body["input"][0]["content"].is_null() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": {
                "type":"invalid_request_error", "message":"reasoning.content must be an array"
            }})),
        );
    }
    (
        StatusCode::OK,
        Json(json!({"id":"resp_qiluyun","object":"response",
        "model":"global:deepseek-v4.1-flash-sg","status":"completed",
        "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"HISTORY_ACCEPTED"}]}],
        "usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}})),
    )
}

#[tokio::test]
async fn qiluyun_empty_reasoning_preserves_history_through_public_responses() {
    let runtime = tempfile::tempdir().unwrap();
    std::env::set_var(
        "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
        runtime.path().join("counter.json"),
    );
    std::env::set_var("V3_QILUYUN_BLACKBOX_KEY", "controlled-external-peer");
    for (profile, success) in [("responses:qiluyun", true), ("compat:passthrough", false)] {
        let captures = Arc::new(Mutex::new(Vec::new()));
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", upstream.local_addr().unwrap());
        let router = Router::new()
            .route("/v1/responses", post(provider))
            .with_state(captures.clone());
        let peer = tokio::spawn(async move { axum::serve(upstream, router).await.unwrap() });
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let declaration = hub_v1_fixture::hub_v1_test_declaration();
        let execution = hub_v1_fixture::hub_v1_server_execution("test");
        let config = format!(
            r#"
version = 3
{declaration}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{execution}
[providers.qiluyun]
type = "responses"
base_url = "{upstream_url}/v1"
default_model = "deepseek-v4.1-flash-sg"
compatibility_profile = "{profile}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_QILUYUN_BLACKBOX_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.qiluyun.models."deepseek-v4.1-flash-sg"]
wire_name = "global:deepseek-v4.1-flash-sg"
capabilities = ["text", "reasoning", "tools"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "qiluyun", model = "deepseek-v4.1-flash-sg", key = "key", priority = 1 }}]
[debug]
log_console = false
"#
        );
        let manifest =
            compile_v3_config_05_manifest(parse_v3_config_02_authoring(&config).unwrap()).unwrap();
        let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
        let input = json!([
            {"type":"reasoning","id":"r_empty","summary":[],"text":"Preserve the empty content item.","content":null},
            {"type":"reasoning","id":"r_present","summary":[],"content":[{"type":"reasoning_text","text":"Keep this reasoning."}]},
            {"type":"reasoning","id":"r_absent","summary":[],"text":"Preserve the absent content item."},
            {"type":"function_call","call_id":"paired","name":"increment","arguments":"{\"value\":41}"},
            {"type":"function_call_output","call_id":"paired","output":"42"},
            {"role":"user","content":"Accept complete history."}
        ]);
        let payload = json!({"model":"qiluyun.deepseek-v4.1-flash-sg","stream":false,
            "input":input,"tools":[{"type":"function","name":"increment","parameters":{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}}]});
        let result = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap()
            .post(format!("http://{}/v1/responses", handle.listeners[0].addr))
            .json(&payload)
            .send()
            .await;
        let response = match result {
            Ok(response) => {
                let status = response.status();
                Ok((status, response.text().await))
            }
            Err(error) => Err(error),
        };
        handle.shutdown().await;
        peer.abort();
        let captured = captures.lock().await;
        assert_eq!(
            captured.len(),
            1,
            "a failed attempt must not be hidden by switching"
        );
        let mut expected = input.clone();
        if success {
            expected[0]["content"] = json!([]);
        }
        assert_eq!(
            captured[0]["input"], expected,
            "preserve each history item and nonempty reasoning"
        );
        assert_eq!(captured[0]["model"], "global:deepseek-v4.1-flash-sg");
        assert_eq!(captured[0]["tools"], payload["tools"]);
        if success {
            let (status, body) =
                response.expect("private profile must allow the real public request");
            let body = body.unwrap();
            assert_eq!(status, StatusCode::OK, "{body}");
            assert!(body.contains("HISTORY_ACCEPTED"), "{body}");
        } else {
            if let Ok((status, body)) = response {
                assert!(
                    status.is_client_error() || status.is_server_error(),
                    "{body:?}"
                );
            }
        }
    }
}
