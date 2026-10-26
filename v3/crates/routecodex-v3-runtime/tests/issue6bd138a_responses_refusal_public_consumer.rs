//! Issue 6bd138a: a legal provider refusal is business content and must
//! survive the public Responses SSE materializer.
//!
//! Run:
//! `CARGO_NET_OFFLINE=true CARGO_TARGET_DIR=/Volumes/Intel/playground/routecodex/6bd138a/v3/target-6bd138a node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --test issue6bd138a_responses_refusal_public_consumer issue6bd138a_refusal_terminal_survives_public_responses_consumer -- --nocapture`

use futures_util::stream;
use routecodex_v3_provider_responses::{V3ProviderError, V3ProviderSseStream};
use routecodex_v3_runtime::materialize_v3_responses_provider_sse_as_canonical_response;
use serde_json::json;

const REFUSAL_TEXT: &str = "I cannot help with that request.";

fn provider_sse_frame(value: serde_json::Value) -> Result<Vec<u8>, V3ProviderError> {
    Ok(format!("data: {value}\n\n").into_bytes())
}

#[tokio::test]
async fn issue6bd138a_refusal_terminal_survives_public_responses_consumer() {
    let stream: V3ProviderSseStream = Box::pin(stream::iter([
        provider_sse_frame(json!({
            "type": "response.refusal.delta",
            "item_id": "msg_6bd138a",
            "output_index": 0,
            "content_index": 0,
            "delta": REFUSAL_TEXT,
        })),
        provider_sse_frame(json!({
            "type": "response.refusal.done",
            "item_id": "msg_6bd138a",
            "output_index": 0,
            "content_index": 0,
            "refusal": REFUSAL_TEXT,
        })),
        provider_sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_6bd138a",
                "status": "completed",
                "output": [{
                    "id": "msg_6bd138a",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "refusal", "refusal": REFUSAL_TEXT}],
                }],
            },
        })),
    ]));

    let canonical = materialize_v3_responses_provider_sse_as_canonical_response(stream)
        .await
        .expect("legal provider refusal must materialize as a canonical response");

    assert_eq!(canonical["status"], "completed");
    assert_eq!(canonical["output"][0]["type"], "message");
    assert_eq!(canonical["output"][0]["content"][0]["type"], "refusal");
    assert_eq!(
        canonical["output"][0]["content"][0]["refusal"],
        REFUSAL_TEXT
    );
}
