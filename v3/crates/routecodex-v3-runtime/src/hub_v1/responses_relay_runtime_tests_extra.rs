use super::*;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::build_v3_transport_13_responses_http_request_from_parts;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn zero_input_usage_uses_request_tiktoken_estimate() {
    let request = json!({
        "model": "gpt-5.5",
        "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]
    });
    let mut response = json!({
        "status": "requires_action",
        "usage": {"input_tokens": 0, "output_tokens": 3, "total_tokens": 3}
    });
    materialize_v3_runtime_input_usage_estimate_from_request(&mut response, &request);
    assert_eq!(response["usage"]["input_tokens"], 2);
    assert_eq!(response["usage"]["total_tokens"], 5);
}

#[test]
fn nonzero_provider_input_usage_is_preserved() {
    let request = json!({
        "model": "gpt-5.5",
        "input": [{"type":"message","role":"user","content":"hello"}]
    });
    let mut response = json!({
        "status": "completed",
        "usage": {"input_tokens": 345678, "output_tokens": 3, "total_tokens": 345681}
    });
    materialize_v3_runtime_input_usage_estimate_from_request(&mut response, &request);
    assert_eq!(response["usage"]["input_tokens"], 345678);
    assert_eq!(response["usage"]["total_tokens"], 345681);
}

#[test]
fn missing_usage_gets_request_tiktoken_input_estimate() {
    let request = json!({
        "model": "gpt-5.5",
        "input": [{"type":"message","role":"user","content":"hello"}]
    });
    let mut response = json!({"status": "completed"});
    materialize_v3_runtime_input_usage_estimate_from_request(&mut response, &request);
    assert_eq!(response["usage"]["input_tokens"], 2);
    assert!(response["usage"].get("total_tokens").is_none());
}

#[tokio::test]
async fn provider_sse_done_without_completed_is_terminal_missing() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
        Ok(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()),
        Ok(b"event: response.done\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n".to_vec()),
        Ok(b"data: [DONE]\n\n".to_vec()),
    ]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[tokio::test]
async fn provider_sse_requires_action_without_completed_is_terminal_missing() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
        b"event: response.requires_action\ndata: {\"type\":\"response.requires_action\",\"response\":{\"id\":\"resp_required\",\"status\":\"requires_action\"},\"required_action\":{\"type\":\"submit_tool_outputs\"}}\n\n".to_vec(),
    )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[path = "responses_relay_runtime_extra_tests.rs"]
mod extracted_tests_tail;
#[path = "responses_relay_runtime_extra_tail_tests.rs"]
mod extracted_tests_tail_2;
