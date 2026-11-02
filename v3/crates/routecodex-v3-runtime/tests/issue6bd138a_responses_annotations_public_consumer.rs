//! Issue 6bd138a: content-part annotations carried by an intermediate provider
//! event must survive a closing `output_item.done` through the public Responses
//! materializer and the public Responses client SSE projection.
//!
//! Run:
//! `CARGO_NET_OFFLINE=true CARGO_TARGET_DIR=/Volumes/Intel/playground/routecodex/6bd138a/v3/target-6bd138a node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --test issue6bd138a_responses_annotations_public_consumer issue6bd138a_annotations_survive_public_materializer_and_client_sse -- --nocapture --exact`

use futures_util::{stream, StreamExt};
use routecodex_v3_provider_responses::{V3ProviderError, V3ProviderSseStream};
use routecodex_v3_runtime::hub_v1::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05;
use routecodex_v3_runtime::materialize_v3_responses_provider_sse_as_canonical_response;
use serde_json::{json, Value};

const ANNOTATION_TEXT: &str = "cited text";

fn provider_sse_frame(value: Value) -> Result<Vec<u8>, V3ProviderError> {
    Ok(format!("data: {value}\n\n").into_bytes())
}

fn annotation_value() -> Value {
    json!([{
        "type": "url_citation",
        "url": "https://example.com/6bd138a",
        "title": "cited"
    }])
}

fn annotated_provider_stream() -> V3ProviderSseStream {
    Box::pin(stream::iter([
        provider_sse_frame(json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": "msg_6bd138a_annotations",
                "type": "message",
                "role": "assistant",
                "status": "in_progress",
                "content": [],
            },
        })),
        provider_sse_frame(json!({
            "type": "response.content_part.done",
            "output_index": 0,
            "item_id": "msg_6bd138a_annotations",
            "content_index": 0,
            "part": {
                "type": "output_text",
                "text": ANNOTATION_TEXT,
                "annotations": annotation_value(),
            },
        })),
        provider_sse_frame(json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "id": "msg_6bd138a_annotations",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": ANNOTATION_TEXT}],
            },
        })),
        provider_sse_frame(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_6bd138a_annotations",
                "status": "completed",
                "output": [{
                    "id": "msg_6bd138a_annotations",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": ANNOTATION_TEXT}],
                }],
            },
        })),
    ]))
}

async fn client_sse_events(response: Value) -> Vec<Value> {
    let stream = build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(response)
        .expect("Responses client projection must accept the canonical response");
    let frames = stream
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|frame| String::from_utf8(frame).expect("client frame UTF-8"))
        .collect::<Vec<_>>();
    frames
        .iter()
        .flat_map(|frame| frame.lines())
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| data.trim() != "[DONE]")
        .map(|data| serde_json::from_str(data).expect("client SSE data must be JSON"))
        .collect()
}

#[tokio::test]
async fn issue6bd138a_annotations_survive_public_materializer_and_client_sse() {
    let canonical =
        materialize_v3_responses_provider_sse_as_canonical_response(annotated_provider_stream())
            .await
            .expect("the annotated provider stream must materialize as a canonical response");

    assert_eq!(canonical["status"], json!("completed"));
    assert_eq!(
        canonical["output"][0]["content"][0]["text"],
        json!(ANNOTATION_TEXT)
    );
    assert_eq!(
        canonical["output"][0]["content"][0]["annotations"],
        annotation_value(),
        "the public materializer must keep annotations that only the intermediate content part carried"
    );

    let events = client_sse_events(canonical).await;
    let done_items = events
        .iter()
        .filter(|event| event["type"] == json!("response.output_item.done"))
        .collect::<Vec<_>>();
    assert_eq!(done_items.len(), 1, "{events:#?}");
    assert_eq!(
        done_items[0]["item"]["content"][0]["annotations"],
        annotation_value(),
        "client output_item.done must keep the intermediate annotations"
    );

    let completed = events
        .iter()
        .filter(|event| event["type"] == json!("response.completed"))
        .collect::<Vec<_>>();
    assert_eq!(
        completed.len(),
        1,
        "exactly one normal terminal: {events:#?}"
    );
    assert_eq!(
        completed[0]["response"]["output"][0]["content"][0]["annotations"],
        annotation_value(),
        "client terminal must keep annotations omitted by the provider terminal"
    );
}
