//! Public HTTP response regression. Run:
//! CARGO_NET_OFFLINE=true cargo test --locked --manifest-path v3/Cargo.toml
//! -p routecodex-v3-server --test no_response_adjudication_blackbox -- --nocapture
//!
//! Native error fixtures are representative protocol fixtures, NOT the QSA
//! sample: its retained body=[] does not identify its original native event.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header::CONTENT_TYPE, HeaderValue, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

#[path = "support/fa22072_test_home.rs"]
mod fa22072_test_home;
static TEST_LOCK: fa22072_test_home::ServerTestLock = fa22072_test_home::ServerTestLock::new();
const KEY_ENV: &str = "V3_NO_RESPONSE_TEST_KEY";
const RECOVERY_KEY_ENV: &str = "V3_NO_RESPONSE_RECOVERY_KEY";

fn issue0ff6700_blank_final() -> Value {
    let mut response = text_response("\n\n\n\n");
    response["output"].as_array_mut().unwrap().insert(
        0,
        json!({
            "id":"reasoning_blank_final", "type":"reasoning",
            "summary":[{"type":"summary_text","text":"PRIVATE_THOUGHT_0FF"}]
        }),
    );
    response
}

fn e63_review_wire(kind: &str, value: &Value, stream: bool) -> String {
    if !stream {
        return value.to_string();
    }
    match kind {
        "responses" => response_sse(value),
        "gemini" => format!("data: {value}\n\n"),
        "openai_chat" => format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            json!({"id":"review-chat","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":value["choices"][0]["message"],"finish_reason":null}]}),
            json!({"id":"review-chat","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
        ),
        "anthropic" => {
            let text = &value["content"][0]["text"];
            let frames = [
                json!({"type":"message_start","message":{"id":"review-message","type":"message","role":"assistant","model":"wire-test","content":[]}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                json!({"type":"message_stop"}),
            ];
            frames
                .iter()
                .map(|event| {
                    format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    )
                })
                .collect()
        }
        _ => unreachable!(),
    }
}

#[derive(Clone, Copy)]
enum E63ReviewOutcome {
    Accept,
    Recover,
    Exhaust,
}

async fn e63_review_attempt(
    kind: &str,
    process: &str,
    native_entry: bool,
    stream: bool,
    first: Value,
    recovered: Value,
    expected: E63ReviewOutcome,
) -> String {
    let recovery = matches!(expected, E63ReviewOutcome::Recover);
    let mut bodies = vec![e63_review_wire(kind, &first, stream)];
    if recovery {
        bodies.push(e63_review_wire(kind, &recovered, stream));
    }
    let auth_entries = if recovery {
        vec![
            ("first".into(), KEY_ENV.into()),
            ("second".into(), RECOVERY_KEY_ENV.into()),
        ]
    } else {
        vec![("first".into(), KEY_ENV.into())]
    };
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        kind,
        process,
        StatusCode::OK,
        if stream {
            "text/event-stream"
        } else {
            "application/json"
        },
        String::new(),
        EntryOptions {
            attempt_bodies: bodies,
            auth_entries,
            ..EntryOptions::default()
        },
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let (endpoint, request) = match (native_entry, kind) {
        (true, "gemini") => (
            format!("{base}/v1beta/models/test.test/generateContent"),
            json!({"contents":[{"role":"user","parts":[{"text":"review-contract"}]}],"stream":stream}),
        ),
        (true, "anthropic") => (
            format!("{base}/v1/messages"),
            json!({"model":"test.test","max_tokens":128,"messages":[{"role":"user","content":"review-contract"}],"stream":stream}),
        ),
        (true, "openai_chat") => (
            format!("{base}/v1/chat/completions"),
            json!({"model":"test.test","messages":[{"role":"user","content":"review-contract"}],"stream":stream}),
        ),
        _ => (
            endpoint,
            json!({"model":"test.test","input":"review-contract","stream":stream}),
        ),
    };
    let consumed = consume_response(client().post(endpoint).json(&request).send().await).await;
    let attempts = std::iter::from_fn(|| captures.try_recv().ok()).count();
    stop_entry(handle, shutdown).await;
    assert_eq!(
        attempts,
        if recovery { 2 } else { 1 },
        "{kind}/{process}/{stream}: {consumed:?}"
    );
    if matches!(expected, E63ReviewOutcome::Exhaust) {
        assert!(
            consumed.transport_error.is_some(),
            "empty attempt must interrupt transport: {consumed:?}"
        );
        assert!(
            !consumed.body.contains("response.completed"),
            "{consumed:?}"
        );
    } else {
        assert!(
            consumed.transport_error.is_none(),
            "{kind}/{process}/{stream}: {consumed:?}"
        );
        assert!(consumed.body.contains("REVIEW_BUSINESS"), "{consumed:?}");
    }
    assert_no_error_payload(&consumed.body);
    consumed.body
}

#[tokio::test]
async fn issuee63d2f2_review_orphan_without_tools_recovers_or_exhausts() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "recovery-secret");
    for stream in [false, true] {
        for expected in [E63ReviewOutcome::Recover, E63ReviewOutcome::Exhaust] {
            let body = e63_review_attempt(
                "responses",
                "chat",
                false,
                stream,
                text_response("Must not escape.\n</｜DSML｜tool_calls>"),
                text_response("REVIEW_BUSINESS"),
                expected,
            )
            .await;
            assert!(
                !body.contains("Must not escape.") && !body.contains("DSML"),
                "{body}"
            );
        }
    }
    std::env::remove_var(RECOVERY_KEY_ENV);
    std::env::remove_var(KEY_ENV);
}

/// One complete governed refill round. SSE ends at the terminal seal.
fn refill_round_wire(stream: bool, text: &str) -> String {
    let response = text_response(text);
    if stream {
        response_sse(&response)
    } else {
        response.to_string()
    }
}

/// A streamed round with a real business item before the terminal. The Direct
/// client commit point flushes `added`/`delta`/`done` to the live sink, while
/// the terminal stays held for refill assembly.
fn streaming_refill_round_sse(item_id: &str, text: &str) -> String {
    let item = json!({
        "id": item_id,
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": text, "annotations": []}]
    });
    let response = json!({
        "id": format!("resp_{item_id}"),
        "object": "response",
        "status": "completed",
        "model": "wire-test",
        "output": [item.clone()]
    });
    format!(
        "{}{}{}{}{}",
        sse(
            "response.created",
            &json!({
                "type": "response.created",
                "response": {
                    "id": format!("resp_{item_id}"),
                    "status": "in_progress",
                    "output": []
                }
            })
        ),
        sse(
            "response.output_item.added",
            &json!({
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "id": item_id,
                    "type": "message",
                    "role": "assistant",
                    "status": "in_progress",
                    "content": []
                }
            })
        ),
        sse(
            "response.output_text.delta",
            &json!({
                "type": "response.output_text.delta",
                "output_index": 0,
                "item_id": item_id,
                "delta": text
            })
        ),
        sse(
            "response.output_item.done",
            &json!({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": item
            })
        ),
        response_sse(&response),
    )
}

/// Same round as `streaming_refill_round_sse`, using CRLF line endings so one
/// provider chunk can carry several coalesced events into the Direct sink.
fn streaming_refill_round_sse_crlf(item_id: &str, text: &str) -> String {
    streaming_refill_round_sse(item_id, text).replace('\n', "\r\n")
}

/// A completed round whose business content exists only in the terminal event.
/// No incremental content frame is ever emitted, so a client that received the
/// next round's live frames first really would see the rounds out of order.
fn terminal_only_refill_round_sse(item_id: &str, text: &str) -> String {
    let response = json!({
        "id": format!("resp_{item_id}"),
        "object": "response",
        "status": "completed",
        "model": "wire-test",
        "output": [{
            "id": item_id,
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}]
        }]
    });
    format!(
        "{}{}",
        sse(
            "response.created",
            &json!({
                "type": "response.created",
                "response": {
                    "id": format!("resp_{item_id}"),
                    "status": "in_progress",
                    "output": []
                }
            })
        ),
        response_sse(&response),
    )
}

/// A completed round with visible text, two consecutive provider-origin
/// reasoning items carrying distinct empty-summary continuation associations,
/// and one anonymous reasoning item that must not be replayed.
fn refill_reasoning_round_wire() -> String {
    json!({
        "id": "resp_reasoning_round",
        "object": "response",
        "status": "completed",
        "model": "wire-test",
        "output": [
            {
                "id": "rsn_provider_capture",
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "opaque-refill-cipher"
            },
            {
                "id": "rsn_provider_capture_second",
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "opaque-refill-cipher-second"
            },
            {
                "id": "rsn_provider_capture_plaintext",
                "type": "reasoning",
                "summary": [],
                "content": [{"type": "reasoning_text", "text": "keep this reasoning"}]
            },
            {
                "id": "msg_reasoning_round",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "REASONING_ROUND_ONE", "annotations": []}]
            },
            {
                "type": "reasoning",
                "summary": []
            }
        ]
    })
    .to_string()
}

/// Source-explicit summary fixture. It bounds an unexpected extra refill so a
/// regression fails by attempt count instead of looping to the transport cap.
fn source_summary_wire(stream: bool, text: &str) -> String {
    let response = json!({
        "id":"resp_source_summary",
        "object":"response",
        "status":"completed",
        "model":"wire-test",
        "output":[
            {
                "id":"rs_source_summary",
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":text}]
            },
            {
                "id":"msg_source_summary",
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{"type":"output_text","text":text,"annotations":[]}]
            }
        ]
    });
    if stream {
        response_sse(&response)
    } else {
        response.to_string()
    }
}

async fn refill_public_chain(
    process: &str,
    stream: bool,
    fallback_body: String,
    attempt_bodies: Vec<String>,
    auth_entries: Vec<(String, String)>,
    refill_max: Option<u32>,
) -> (ConsumedResponse, usize) {
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        process,
        StatusCode::OK,
        if stream {
            "text/event-stream"
        } else {
            "application/json"
        },
        fallback_body,
        EntryOptions {
            attempt_bodies,
            auth_entries,
            refill_max,
            ..EntryOptions::default()
        },
    )
    .await;
    let consumed = consume_response(
        client()
            .post(&endpoint)
            .json(&json!({
                "model":"test.test",
                "input":"controlled refill regression",
                "stream":stream
            }))
            .send()
            .await,
    )
    .await;
    let attempts = std::iter::from_fn(|| captures.try_recv().ok()).count();
    stop_entry(handle, shutdown).await;
    (consumed, attempts)
}

/// Stable public ID: limit 0 delivers the original governed response exactly
/// once on JSON for both Chat Process and Direct.
#[tokio::test]
async fn refill_limit_zero_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["chat", "direct"] {
        let wire = refill_round_wire(false, "ZERO_BUSINESS");
        let (consumed, attempts) = refill_public_chain(
            process,
            false,
            source_summary_wire(false, "ZERO_UNEXPECTED_REFILL"),
            vec![wire],
            Vec::new(),
            Some(0),
        )
        .await;
        assert_eq!(
            attempts, 1,
            "{process}: limit 0 must not refill: {consumed:?}"
        );
        assert!(
            consumed.transport_error.is_none(),
            "{process}: original response must deliver: {consumed:?}"
        );
        assert!(
            consumed.body.contains("ZERO_BUSINESS"),
            "{process}: original business text must reach the client: {consumed:?}"
        );
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: the default limit is exactly one refill. A third attempt
/// would receive the source-summary fallback and fail the attempt count.
#[tokio::test]
async fn refill_default_exactly_two_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["chat", "direct"] {
        for stream in [false, true] {
            let (consumed, attempts) = refill_public_chain(
                process,
                stream,
                source_summary_wire(stream, "UNEXPECTED_THIRD_ROUND"),
                vec![
                    refill_round_wire(stream, "ROUND_ONE"),
                    refill_round_wire(stream, "ROUND_TWO"),
                ],
                Vec::new(),
                None,
            )
            .await;
            assert_eq!(
                attempts, 2,
                "{process}/{stream}: default limit must stop after one refill: {consumed:?}"
            );
            assert!(
                consumed.transport_error.is_none(),
                "{process}/{stream}: refill chain must deliver normally: {consumed:?}"
            );
            assert!(
                consumed.body.contains("ROUND_ONE") && consumed.body.contains("ROUND_TWO"),
                "{process}/{stream}: both rounds must be preserved: {consumed:?}"
            );
            assert_no_error_payload(&consumed.body);
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: limit 3 allows exactly three new executions beyond the
/// original. The plain fallback answers the fourth attempt; a fifth attempt
/// means the budget was not honored.
#[tokio::test]
async fn refill_limit_three_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (consumed, attempts) = refill_public_chain(
        "chat",
        false,
        refill_round_wire(false, "R4_FALLBACK"),
        vec![
            refill_round_wire(false, "R1"),
            refill_round_wire(false, "R2"),
            refill_round_wire(false, "R3"),
        ],
        Vec::new(),
        Some(3),
    )
    .await;
    assert_eq!(
        attempts, 4,
        "limit 3 must allow original plus three refills: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "refill chain must deliver normally: {consumed:?}"
    );
    assert!(
        consumed.body.contains("R1")
            && consumed.body.contains("R2")
            && consumed.body.contains("R3"),
        "each refill round must be preserved: {consumed:?}"
    );
    assert_no_error_payload(&consumed.body);
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: reasoning `content`/`text` without a `summary` array is
/// RCC synthesis input, not a source summary. It must not stop refill.
#[tokio::test]
async fn refill_synthesized_summary_does_not_stop_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let synthesized = json!({
        "id":"resp_synth",
        "object":"response",
        "status":"completed",
        "model":"wire-test",
        "output":[
            {
                "id":"rs_synth",
                "type":"reasoning",
                "content":[{"type":"reasoning_text","text":"SYNTH_CONTENT"}],
                "text":"SYNTH_TEXT"
            },
            {
                "id":"msg_synth",
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{"type":"output_text","text":"SYNTH_BUSINESS","annotations":[]}]
            }
        ]
    });
    let (consumed, attempts) = refill_public_chain(
        "chat",
        false,
        source_summary_wire(false, "SYNTH_STOP"),
        vec![synthesized.to_string()],
        Vec::new(),
        None,
    )
    .await;
    assert_eq!(
        attempts, 2,
        "synthesized reasoning text must not count as a source summary: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "synthesized round must deliver normally: {consumed:?}"
    );
    assert!(
        consumed.body.contains("SYNTH_BUSINESS"),
        "synthesized business text must reach the client: {consumed:?}"
    );
    assert_no_error_payload(&consumed.body);
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: an empty completed attempt enters the existing Error
/// chain, reselects the remaining key, then refills from the recovered
/// governed result. The empty provider body never reaches the client.
#[tokio::test]
async fn refill_error_chain_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "recovery-secret");
    let empty_attempt_body = json!({
        "id":"resp_empty",
        "object":"response",
        "status":"completed",
        "model":"wire-test",
        "output":[]
    })
    .to_string();
    let auth_entries = vec![
        ("empty-key".to_string(), KEY_ENV.to_string()),
        ("recovery-key".to_string(), RECOVERY_KEY_ENV.to_string()),
    ];
    let (consumed, attempts) = refill_public_chain(
        "chat",
        false,
        refill_round_wire(false, "REFILL_FALLBACK"),
        vec![
            empty_attempt_body,
            refill_round_wire(false, "AFTER_RECOVERY"),
        ],
        auth_entries,
        None,
    )
    .await;
    assert!(
        attempts >= 3,
        "empty recovery, governed success and refill must all execute: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "recovered refill chain must complete: {consumed:?}"
    );
    assert!(
        consumed.body.contains("AFTER_RECOVERY"),
        "recovered business text must reach the client: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("resp_empty"),
        "empty provider body must not leak: {consumed:?}"
    );
    assert_no_error_payload(&consumed.body);
    std::env::remove_var(RECOVERY_KEY_ENV);
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: Relay and Direct share the same policy and preserve both
/// rounds. SSE emits one completed event and no error event.
#[tokio::test]
async fn refill_direct_relay_content_parity_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["chat", "direct"] {
        for stream in [false, true] {
            let (consumed, attempts) = refill_public_chain(
                process,
                stream,
                source_summary_wire(stream, "PARITY_STOP"),
                vec![
                    refill_round_wire(stream, "PARITY_FIRST"),
                    refill_round_wire(stream, "PARITY_SECOND"),
                ],
                Vec::new(),
                None,
            )
            .await;
            assert_eq!(
                attempts, 2,
                "{process}/{stream}: both paths must stop after one default refill: {consumed:?}"
            );
            assert!(
                consumed.transport_error.is_none(),
                "{process}/{stream}: parity chain must deliver normally: {consumed:?}"
            );
            assert!(
                consumed.body.contains("PARITY_FIRST") && consumed.body.contains("PARITY_SECOND"),
                "{process}/{stream}: both round texts must survive: {consumed:?}"
            );
            assert_no_error_payload(&consumed.body);
            if stream {
                let payloads = events(&consumed.body);
                assert_eq!(
                    payloads
                        .iter()
                        .filter(|event| event["type"] == "response.completed")
                        .count(),
                    1,
                    "{process}: exactly one completed event: {consumed:?}"
                );
                assert!(
                    !payloads.iter().any(|event| event["type"] == "error"),
                    "{process}: no error event may reach the client: {consumed:?}"
                );
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn refill_direct_sse_summary_after_diagnostic_cap_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    // The raw provider diagnostic keeps only 2 MiB. Put the provider-explicit
    // reasoning summary after that boundary so a refill decision that reads
    // the diagnostic would miss it.
    let mut wire = String::new();
    while wire.len() < 2 * 1024 * 1024 + 64 * 1024 {
        wire.push_str(": diagnostic-padding\n\n");
    }
    wire.push_str(&source_summary_wire(true, "LATE_SOURCE_SUMMARY"));
    let (consumed, attempts) = refill_public_chain(
        "direct",
        true,
        source_summary_wire(true, "UNEXPECTED_REFILL"),
        vec![wire],
        Vec::new(),
        None,
    )
    .await;
    assert_eq!(
        attempts, 1,
        "a source summary after the diagnostic cap must stop refill: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "the original stream must deliver: {consumed:?}"
    );
    assert!(
        consumed.body.contains("LATE_SOURCE_SUMMARY"),
        "the late summary must reach the client: {consumed:?}"
    );
    assert_no_error_payload(&consumed.body);
    std::env::remove_var(KEY_ENV);
}

/// Direct SSE early delivery: round content already flushed to the live sink
/// must not be synthesized again, and round two must continue the request-wide
/// output index instead of reusing index 0.
#[tokio::test]
async fn refill_direct_sse_first_frame_delivery_keeps_item_identity_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (consumed, attempts) = refill_public_chain(
        "direct",
        true,
        streaming_refill_round_sse("msg_unexpected_third", "UNEXPECTED_THIRD"),
        vec![
            streaming_refill_round_sse("msg_round_one", "EARLY_ONE"),
            streaming_refill_round_sse("msg_round_two", "EARLY_TWO"),
        ],
        Vec::new(),
        None,
    )
    .await;
    assert_eq!(
        attempts, 2,
        "the default limit must stop after one refill: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "both rounds must deliver: {consumed:?}"
    );
    let payloads = events(&consumed.body);
    let completed: Vec<&Value> = payloads
        .iter()
        .filter(|event| event["type"] == "response.completed")
        .collect();
    assert_eq!(completed.len(), 1, "{consumed:?}");
    let output = completed[0]["response"]["output"]
        .as_array()
        .expect("final output array");
    let order: Vec<&str> = output
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect();
    assert_eq!(
        order,
        vec!["msg_round_one", "msg_round_two"],
        "{consumed:?}"
    );
    for (position, item_id) in order.iter().enumerate() {
        let done: Vec<&Value> = payloads
            .iter()
            .filter(|event| {
                event["type"] == "response.output_item.done"
                    && event.pointer("/item/id").and_then(Value::as_str) == Some(*item_id)
            })
            .collect();
        assert_eq!(
            done.len(),
            1,
            "{item_id} must be delivered exactly once: {payloads:?}"
        );
        assert_eq!(
            done[0]["output_index"].as_u64(),
            Some(position as u64),
            "{item_id} output_index must match the final output order: {payloads:?}"
        );
    }
    assert!(
        !payloads.iter().any(|event| event["type"] == "error"),
        "no error event may reach the client: {consumed:?}"
    );
    std::env::remove_var(KEY_ENV);
}

/// db1f482 last-candidate regression at the real public HTTP entry: a
/// completely received upstream HTTP 502 with an HTML error body is an
/// ordinary provider error, not a typed transport failure. It must terminate
/// the request transport without creating provider health cooldown.
#[tokio::test]
async fn db1f482_complete_upstream_http_502_keeps_last_candidate_health_neutral() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (endpoint, handle, mut captures, _headers, shutdown) = start_entry_configured(
        "responses",
        "relay",
        StatusCode::BAD_GATEWAY,
        "text/html",
        "<html><body>upstream gateway failure</body></html>".to_string(),
        EntryOptions {
            health_enabled: true,
            attempt_statuses: vec![StatusCode::BAD_GATEWAY],
            ..EntryOptions::default()
        },
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let consumed = consume_response(
        client()
            .post(&endpoint)
            .json(&json!({
                "model":"test.test",
                "input":"db1f482 complete upstream HTTP 502",
                "stream":false
            }))
            .send()
            .await,
    )
    .await;
    assert_no_error_payload(&consumed.body);
    assert!(
        consumed.transport_error.is_some(),
        "a complete upstream HTTP error must terminate only the request transport: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("response.completed"),
        "no fabricated business completion is allowed: {consumed:?}"
    );
    let health: Value = client()
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        health["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["provider_id"] != "test"),
        "complete upstream HTTP 502 must not cool the last candidate: {health}"
    );
    stop_entry(handle, shutdown).await;
    let mut attempts = 0;
    while let Some(capture) = captures.recv().await {
        if capture
            .to_string()
            .contains("db1f482 complete upstream HTTP 502")
        {
            attempts += 1;
        }
    }
    assert_eq!(
        attempts, 1,
        "a complete upstream HTTP error must not retry the last candidate"
    );
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: a coalesced CRLF provider chunk must keep every event when
/// the refill live sink shifts request-wide output indexes.
#[tokio::test]
async fn refill_direct_crlf_multi_event_chunk_keeps_every_event_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (consumed, attempts) = refill_public_chain(
        "direct",
        true,
        streaming_refill_round_sse_crlf("msg_unexpected_third", "UNEXPECTED_THIRD"),
        vec![
            streaming_refill_round_sse_crlf("msg_crlf_one", "CRLF_ONE"),
            streaming_refill_round_sse_crlf("msg_crlf_two", "CRLF_TWO"),
        ],
        Vec::new(),
        None,
    )
    .await;
    assert_eq!(
        attempts, 2,
        "the default limit must stop after one refill: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "both rounds must deliver: {consumed:?}"
    );
    let payloads = events(&consumed.body);
    let completed: Vec<&Value> = payloads
        .iter()
        .filter(|event| event["type"] == "response.completed")
        .collect();
    assert_eq!(completed.len(), 1, "{consumed:?}");
    let output = completed[0]["response"]["output"]
        .as_array()
        .expect("final output array");
    let order: Vec<&str> = output
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect();
    assert_eq!(order, vec!["msg_crlf_one", "msg_crlf_two"], "{consumed:?}");
    for (text, index) in [("CRLF_ONE", 0u64), ("CRLF_TWO", 1u64)] {
        let deltas: Vec<&Value> = payloads
            .iter()
            .filter(|event| event["type"] == "response.output_text.delta" && event["delta"] == text)
            .collect();
        assert_eq!(
            deltas.len(),
            1,
            "{text} delta must survive the offset rewrite: {payloads:?}"
        );
        assert_eq!(
            deltas[0]["output_index"].as_u64(),
            Some(index),
            "{text} output_index must match the final output order: {payloads:?}"
        );
    }
    assert!(
        !payloads.iter().any(|event| event["type"] == "error"),
        "no error event may reach the client: {consumed:?}"
    );
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: round one carries its business content only in the terminal
/// event while round two streams incrementally. The client must still receive
/// round one's content before any round-two frame, once per item, with a single
/// final completion event.
#[tokio::test]
async fn refill_direct_sse_round_ordering_terminal_then_incremental_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (consumed, attempts) = refill_public_chain(
        "direct",
        true,
        streaming_refill_round_sse("msg_unexpected_third", "UNEXPECTED_THIRD"),
        vec![
            terminal_only_refill_round_sse("msg_terminal_one", "TERMINAL_ONE"),
            streaming_refill_round_sse("msg_incremental_two", "INCREMENTAL_TWO"),
        ],
        Vec::new(),
        None,
    )
    .await;
    assert_eq!(
        attempts, 2,
        "the default limit must stop after one refill: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "both rounds must deliver: {consumed:?}"
    );
    let payloads = events(&consumed.body);
    // A terminal-only round reaches the client as a synthesized
    // `output_item.done`; an incremental round additionally streams deltas. The
    // wire order of the done events is the request-level business order.
    let arrival: Vec<&str> = payloads
        .iter()
        .filter_map(|event| {
            if event["type"] == "response.output_item.done" {
                event.pointer("/item/id").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        arrival,
        vec!["msg_terminal_one", "msg_incremental_two"],
        "round one must reach the client before round two: {payloads:?}"
    );
    let completed: Vec<&Value> = payloads
        .iter()
        .filter(|event| event["type"] == "response.completed")
        .collect();
    assert_eq!(completed.len(), 1, "{payloads:?}");
    let output = completed[0]["response"]["output"]
        .as_array()
        .expect("final output array");
    let item_order: Vec<&str> = output
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect();
    assert_eq!(
        item_order,
        vec!["msg_terminal_one", "msg_incremental_two"],
        "{payloads:?}"
    );
    for (position, item_id) in item_order.iter().enumerate() {
        let done: Vec<&Value> = payloads
            .iter()
            .filter(|event| {
                event["type"] == "response.output_item.done"
                    && event.pointer("/item/id").and_then(Value::as_str) == Some(*item_id)
            })
            .collect();
        assert_eq!(
            done.len(),
            1,
            "{item_id} must be delivered exactly once: {payloads:?}"
        );
        assert_eq!(
            done[0]["output_index"].as_u64(),
            Some(position as u64),
            "{item_id} output_index must match the final output order: {payloads:?}"
        );
    }
    assert!(
        !payloads.iter().any(|event| event["type"] == "error"),
        "no error event may reach the client: {consumed:?}"
    );
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: the refill continuation must keep the provider-origin
/// reasoning id and encrypted material through both execution wrappers.
#[tokio::test]
async fn refill_continuation_captures_provider_reasoning_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["direct", "chat"] {
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            process,
            StatusCode::OK,
            "application/json",
            source_summary_wire(false, "REASONING_ROUND_TWO"),
            EntryOptions {
                attempt_bodies: vec![refill_reasoning_round_wire()],
                refill_max: None,
                model_key: Some("gpt-5.6-sol".to_string()),
                wire_model: Some("gpt-5.6-sol".to_string()),
                ..EntryOptions::default()
            },
        )
        .await;
        let consumed = consume_response(
            client()
                .post(&endpoint)
                .json(&json!({
                    "model": "test.gpt-5.6-sol",
                    "input": "controlled refill reasoning capture",
                    "stream": false
                }))
                .send()
                .await,
        )
        .await;
        let mut captured = Vec::new();
        while let Ok(value) = captures.try_recv() {
            captured.push(value);
        }
        stop_entry(handle, shutdown).await;
        assert_eq!(
            captured.len(),
            2,
            "{process}: one refill execution must reach the provider: {consumed:?}"
        );
        assert!(
            consumed.transport_error.is_none(),
            "{process}: refill chain must deliver: {consumed:?}"
        );
        assert!(
            consumed.body.contains("REASONING_ROUND_ONE")
                && consumed.body.contains("REASONING_ROUND_TWO"),
            "{process}: both rounds must reach the client: {consumed:?}"
        );
        assert!(
            !captured[1].to_string().contains("rcc_reason_"),
            "{process}: synthesized reasoning must not be replayed: {}",
            captured[1]
        );
        let input = captured[1]["input"].as_array().unwrap_or_else(|| {
            panic!(
                "{process}: provider request must carry input: {}",
                captured[1]
            )
        });
        let reasoning: Vec<&Value> = input
            .iter()
            .filter(|item| item["type"] == "reasoning")
            .collect();
        assert_eq!(
            reasoning.len(),
            3,
            "{process}: every provider-origin reasoning item must replay: {input:?}"
        );
        assert_eq!(
            reasoning[0]["id"],
            json!("rsn_provider_capture"),
            "{process}"
        );
        assert_eq!(
            reasoning[0]["encrypted_content"],
            json!("opaque-refill-cipher"),
            "{process}"
        );
        assert_eq!(
            reasoning[1]["id"],
            json!("rsn_provider_capture_second"),
            "{process}"
        );
        assert_eq!(
            reasoning[1]["encrypted_content"],
            json!("opaque-refill-cipher-second"),
            "{process}"
        );
        assert_eq!(
            reasoning[2]["id"],
            json!("rsn_provider_capture_plaintext"),
            "{process}"
        );
        assert_eq!(
            reasoning[2]["content"],
            json!([{"type":"reasoning_text","text":"keep this reasoning"}]),
            "{process}: per-item reasoning plaintext must keep its item association"
        );
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: a messages-shaped refill continuation must keep same-turn
/// provider reasoning and assistant content associated, and its Responses
/// projection must not fabricate an empty assistant message.
///
/// The messages branch of the refill continuation is owned by the Responses
/// relay runtime. `/v1/chat/completions` in this build enters the Chat runtime,
/// which has no bounded-refill loop, so the reachable public entry that carries
/// a `messages` payload through bounded refill is `/v1/responses`.
#[tokio::test]
async fn refill_continuation_messages_shape_keeps_reasoning_association_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        "chat",
        StatusCode::OK,
        "application/json",
        source_summary_wire(false, "MESSAGES_ROUND_TWO"),
        EntryOptions {
            attempt_bodies: vec![refill_reasoning_round_wire()],
            refill_max: None,
            model_key: Some("gpt-5.6-sol".to_string()),
            wire_model: Some("gpt-5.6-sol".to_string()),
            ..EntryOptions::default()
        },
    )
    .await;
    let consumed = consume_response(
        client()
            .post(&endpoint)
            .json(&json!({
                "model": "test.gpt-5.6-sol",
                "messages": [
                    {"role": "user", "content": "continue the chat-shaped refill"}
                ],
                "stream": false
            }))
            .send()
            .await,
    )
    .await;
    let mut captured = Vec::new();
    while let Ok(value) = captures.try_recv() {
        captured.push(value);
    }
    stop_entry(handle, shutdown).await;
    assert_eq!(
        captured.len(),
        2,
        "one refill execution must reach the provider: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "refill chain must deliver: {consumed:?}"
    );
    assert!(
        consumed.body.contains("REASONING_ROUND_ONE")
            && consumed.body.contains("MESSAGES_ROUND_TWO"),
        "both rounds must reach the client: {consumed:?}"
    );
    let input = captured[1]["input"].as_array().unwrap_or_else(|| {
        panic!(
            "second provider request must carry Responses input: {}",
            captured[1]
        )
    });
    let reasoning: Vec<(usize, &Value)> = input
        .iter()
        .enumerate()
        .filter(|(_, item)| item["type"] == "reasoning")
        .collect();
    assert_eq!(
        reasoning.len(),
        3,
        "every provider-origin reasoning item must replay: {input:?}"
    );
    assert_eq!(reasoning[0].1["id"], json!("rsn_provider_capture"));
    assert_eq!(
        reasoning[0].1["encrypted_content"],
        json!("opaque-refill-cipher")
    );
    assert_eq!(reasoning[1].1["id"], json!("rsn_provider_capture_second"));
    assert_eq!(
        reasoning[1].1["encrypted_content"],
        json!("opaque-refill-cipher-second")
    );
    assert_eq!(
        reasoning[2].1["id"],
        json!("rsn_provider_capture_plaintext")
    );
    assert_eq!(
        reasoning[2].1["content"],
        json!([{"type": "reasoning_text", "text": "keep this reasoning"}])
    );
    let assistant_messages: Vec<(usize, &Value)> = input
        .iter()
        .enumerate()
        .filter(|(_, item)| item["type"] == "message" && item["role"] == "assistant")
        .collect();
    assert_eq!(
        assistant_messages.len(),
        1,
        "same-turn reasoning must not fabricate a second assistant message: {input:?}"
    );
    let (assistant_index, assistant_message) = assistant_messages[0];
    assert!(
        assistant_message["content"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(|part| {
                part["type"] == "output_text" && part["text"] == json!("REASONING_ROUND_ONE")
            })),
        "assistant content must stay complete: {input:?}"
    );
    assert_eq!(
        assistant_index,
        reasoning[2].0 + 1,
        "reasoning items must stay adjacent to their assistant content: {input:?}"
    );
    assert_no_error_payload(&consumed.body);
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: a provider refusal is legal business content, so a refill
/// continuation must replay the complete assistant message into the next
/// provider request instead of dropping it.
#[tokio::test]
async fn refill_continuation_preserves_provider_refusal_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    const REFUSAL: &str = "provider declined the controlled refill request";
    for process in ["direct", "chat"] {
        let refusal_round = json!({
            "id": "resp_refusal_round_one",
            "object": "response",
            "status": "completed",
            "model": "wire-test",
            "output": [{
                "id": "msg_refusal_round_one",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "refusal", "refusal": REFUSAL}]
            }]
        })
        .to_string();
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            process,
            StatusCode::OK,
            "application/json",
            text_response("REFUSAL_ROUND_TWO").to_string(),
            EntryOptions {
                attempt_bodies: vec![refusal_round],
                refill_max: None,
                model_key: Some("gpt-5.6-sol".to_string()),
                wire_model: Some("gpt-5.6-sol".to_string()),
                ..EntryOptions::default()
            },
        )
        .await;
        let consumed = consume_response(
            client()
                .post(&endpoint)
                .json(&json!({
                    "model": "test.gpt-5.6-sol",
                    "input": "controlled refill refusal preservation",
                    "stream": false
                }))
                .send()
                .await,
        )
        .await;
        let mut captured = Vec::new();
        while let Ok(value) = captures.try_recv() {
            captured.push(value);
        }
        stop_entry(handle, shutdown).await;
        assert_eq!(
            captured.len(),
            2,
            "{process}: refusal must not stop the bounded refill execution: {consumed:?}"
        );
        assert!(
            consumed.transport_error.is_none(),
            "{process}: refusal refill chain must deliver: {consumed:?}"
        );
        assert!(
            consumed.body.contains(REFUSAL) && consumed.body.contains("REFUSAL_ROUND_TWO"),
            "{process}: both rounds must reach the client: {consumed:?}"
        );
        let input = captured[1]["input"].as_array().unwrap_or_else(|| {
            panic!(
                "{process}: second provider request must carry input: {}",
                captured[1]
            )
        });
        let replayed_refusal = input.iter().find_map(|item| {
            (item["role"] == "assistant")
                .then(|| {
                    item["content"].as_array().and_then(|parts| {
                        parts
                            .iter()
                            .find(|part| part["type"] == "refusal" && part["refusal"] == REFUSAL)
                    })
                })
                .flatten()
        });
        assert!(
            replayed_refusal.is_some(),
            "{process}: refusal content must be replayed in the second provider request: {input:?}"
        );
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn responses_relay_history_preserves_per_item_reasoning_summary_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["chat"] {
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            process,
            StatusCode::OK,
            "application/json",
            text_response("HISTORY_ROUND_TWO").to_string(),
            EntryOptions {
                model_key: Some("gpt-5.6-sol".to_string()),
                wire_model: Some("gpt-5.6-sol".to_string()),
                ..EntryOptions::default()
            },
        )
        .await;
        let consumed = consume_response(
            client()
                .post(&endpoint)
                .json(&json!({
                    "model": "test.gpt-5.6-sol",
                    "input": [
                        {"type":"message","role":"user","content":[{"type":"input_text","text":"continue the paired reasoning history"}]},
                        {"type":"reasoning","id":"rsn_history_first","summary":[{"type":"summary_text","text":"first plaintext"}],"encrypted_content":"cipher-first"},
                        {"type":"reasoning","id":"rsn_history_second","summary":[{"type":"summary_text","text":"second plaintext"}],"encrypted_content":"cipher-second"},
                        {"type":"function_call","id":"fc_history","call_id":"call_history","name":"lookup","arguments":"{\"q\":\"history\"}"},
                        {"type":"function_call_output","call_id":"call_history","output":"history result"}
                    ],
                    "stream": false
                }))
                .send()
                .await,
        )
        .await;
        let captured = tokio::time::timeout(Duration::from_secs(2), captures.recv())
            .await
            .expect("real provider attempt")
            .unwrap();
        stop_entry(handle, shutdown).await;
        assert!(
            consumed.transport_error.is_none(),
            "{process}: relay history must deliver: {consumed:?}"
        );
        assert!(
            consumed.body.contains("mixed roundtrip complete"),
            "{process}: provider business text must reach client: {consumed:?}"
        );
        let reasoning: Vec<&Value> = captured["input"]
            .as_array()
            .unwrap_or_else(|| panic!("{process}: provider request must carry input: {captured}"))
            .iter()
            .filter(|item| item["type"] == "reasoning")
            .collect();
        assert_eq!(reasoning.len(), 2, "{process}: {captured}");
        assert_eq!(reasoning[0]["id"], json!("rsn_history_first"), "{process}");
        assert_eq!(
            reasoning[0]["summary"],
            json!([{"type":"summary_text","text":"first plaintext"}]),
            "{process}"
        );
        assert_eq!(
            reasoning[0]["encrypted_content"],
            json!("cipher-first"),
            "{process}"
        );
        assert_eq!(reasoning[1]["id"], json!("rsn_history_second"), "{process}");
        assert_eq!(
            reasoning[1]["summary"],
            json!([{"type":"summary_text","text":"second plaintext"}]),
            "{process}"
        );
        assert_eq!(
            reasoning[1]["encrypted_content"],
            json!("cipher-second"),
            "{process}"
        );
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn responses_relay_legacy_reasoning_keeps_original_summary_whitespace_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["chat"] {
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            process,
            StatusCode::OK,
            "application/json",
            text_response("LEGACY_WHITESPACE_ROUND").to_string(),
            EntryOptions {
                model_key: Some("gpt-5.6-sol".to_string()),
                wire_model: Some("gpt-5.6-sol".to_string()),
                ..EntryOptions::default()
            },
        )
        .await;
        let consumed = consume_response(
            client()
                .post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
                .json(&json!({
                    "model": "test.gpt-5.6-sol",
                    "messages": [
                        {"role":"user","content":"continue legacy reasoning"},
                        {"role":"assistant","content":"prior answer","reasoning_content":"\n    return value\n"}
                    ],
                    "stream": false
                }))
                .send()
                .await,
        )
        .await;
        let captured = tokio::time::timeout(Duration::from_secs(2), captures.recv())
            .await
            .expect("real provider attempt")
            .unwrap();
        stop_entry(handle, shutdown).await;
        assert!(
            consumed.transport_error.is_none(),
            "{process}: legacy reasoning history must deliver: {consumed:?}"
        );
        let reasoning: Vec<&Value> = captured["input"]
            .as_array()
            .unwrap_or_else(|| panic!("{process}: provider request must carry input: {captured}"))
            .iter()
            .filter(|item| item["type"] == "reasoning")
            .collect();
        assert_eq!(reasoning.len(), 1, "{process}: {captured}");
        assert_eq!(
            reasoning[0]["summary"],
            json!([{"type":"summary_text","text":"\n    return value\n"}]),
            "{process}: legacy fallback must keep original text with whitespace"
        );
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn issuee63d2f2_review_signed_gemini_thought_is_not_a_result() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "recovery-secret");
    let thought = json!({"thought":true,"text":"PRIVATE_REVIEW_THOUGHT","thoughtSignature":"REVIEW_SIGNATURE"});
    let bad = json!({"candidates":[{"content":{"role":"model","parts":[thought]},"finishReason":"STOP"}]});
    let good = json!({"candidates":[{"content":{"role":"model","parts":[{"text":"REVIEW_BUSINESS"}]},"finishReason":"STOP"}]});
    for native in [true, false] {
        for stream in [false, true] {
            for expected in [E63ReviewOutcome::Recover, E63ReviewOutcome::Exhaust] {
                let body = e63_review_attempt(
                    "gemini",
                    if native { "direct" } else { "chat" },
                    native,
                    stream,
                    bad.clone(),
                    good.clone(),
                    expected,
                )
                .await;
                assert!(!body.contains("PRIVATE_REVIEW_THOUGHT"), "{body}");
            }
            for result in [
                json!({"text":"REVIEW_BUSINESS"}),
                json!({"inlineData":{"mimeType":"application/octet-stream","data":"REVIEW_BUSINESS"}}),
            ] {
                let mixed = json!({"candidates":[{"content":{"role":"model","parts":[thought.clone(),result]},"finishReason":"STOP"}]});
                let body = e63_review_attempt(
                    "gemini",
                    if native { "direct" } else { "chat" },
                    native,
                    stream,
                    mixed.clone(),
                    mixed,
                    E63ReviewOutcome::Accept,
                )
                .await;
                assert!(
                    body.contains("PRIVATE_REVIEW_THOUGHT") && body.contains("REVIEW_SIGNATURE"),
                    "{body}"
                );
            }
        }
    }
    std::env::remove_var(RECOVERY_KEY_ENV);
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn issuee63d2f2_review_anthropic_invisible_sse_is_empty() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "recovery-secret");
    let response = |text: &str| json!({"id":"review-message","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":text}],"stop_reason":"end_turn"});
    for text in ["   ", "\u{200b}"] {
        for expected in [E63ReviewOutcome::Recover, E63ReviewOutcome::Exhaust] {
            e63_review_attempt(
                "anthropic",
                "direct",
                true,
                true,
                response(text),
                response("REVIEW_BUSINESS"),
                expected,
            )
            .await;
        }
    }
    e63_review_attempt(
        "anthropic",
        "direct",
        true,
        true,
        response("REVIEW_BUSINESS"),
        response("REVIEW_BUSINESS"),
        E63ReviewOutcome::Accept,
    )
    .await;
    std::env::remove_var(RECOVERY_KEY_ENV);
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn issuee63d2f2_review_structured_chat_text_stays_business() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let text = json!({"answer":"REVIEW_BUSINESS","nested":[1,true,{"opaque":"preserved"}]});
    let value = json!({"id":"review-chat","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":[{"type":"text","text":text}]},"finish_reason":"stop"}]});
    for stream in [false, true] {
        let body = e63_review_attempt(
            "openai_chat",
            "direct",
            true,
            stream,
            value.clone(),
            value.clone(),
            E63ReviewOutcome::Accept,
        )
        .await;
        let frames = if stream {
            events(&body)
        } else {
            vec![serde_json::from_str::<Value>(&body).unwrap()]
        };
        assert!(
            frames.iter().any(|frame| {
                frame["choices"][0]
                    .get(if stream { "delta" } else { "message" })
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_array)
                    .is_some_and(|parts| {
                        parts.iter().any(|part| {
                            part["text"] == text
                                || part["text"]
                                    .as_str()
                                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                                    .as_ref()
                                    == Some(&text)
                        })
                    })
            }),
            "structured value must remain complete: {body}"
        );
    }
    std::env::remove_var(KEY_ENV);
}

/// e63d2f2: reasoning survives alongside a result, but cannot authorize an
/// otherwise empty complete attempt after response governance.
#[tokio::test]
async fn issuee63d2f2_direct_reasoning_only_recovers_json_and_sse() {
    for stream in [false, true] {
        let mut body = issue0ff6700_blank_final();
        body["output"].as_array_mut().unwrap().pop();
        let wire = if stream {
            response_sse(&body)
        } else {
            body.to_string()
        };
        issue0ff6700_run_body("direct", stream, true, Some(wire)).await;
    }
}

#[tokio::test]
async fn issuee63d2f2_relay_reasoning_only_recovers_json_and_sse() {
    for stream in [false, true] {
        let mut body = issue0ff6700_blank_final();
        body["output"].as_array_mut().unwrap().pop();
        let wire = if stream {
            response_sse(&body)
        } else {
            body.to_string()
        };
        issue0ff6700_run_body("chat", stream, true, Some(wire)).await;
    }
}

#[tokio::test]
async fn issuee63d2f2_reasoning_only_exhaustion_interrupts_transport() {
    for process in ["direct", "chat"] {
        for stream in [false, true] {
            let mut body = issue0ff6700_blank_final();
            body["output"].as_array_mut().unwrap().pop();
            let wire = if stream {
                response_sse(&body)
            } else {
                body.to_string()
            };
            issue0ff6700_run_body(process, stream, false, Some(wire)).await;
        }
    }
}

#[tokio::test]
async fn issuee63d2f2_chat_provider_reasoning_only_never_completes_empty() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for stream in [false, true] {
        let upstream = if stream {
            format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({"id":"chat-e63","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"PRIVATE_REASONING_E63"},"finish_reason":null}]}),
                json!({"id":"chat-e63","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
            )
        } else {
            json!({"id":"chat-e63","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":"PRIVATE_REASONING_E63"},"finish_reason":"stop"}]}).to_string()
        };
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "openai_chat",
            "chat",
            StatusCode::OK,
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
            upstream,
        )
        .await;
        let consumed = consume_response(client().post(&endpoint)
            .json(&json!({"model":"test.test","input":"reasoning-only provider control","stream":stream}))
            .send().await).await;
        stop_entry(handle, shutdown).await;
        assert!(consumed.transport_error.is_some(), "{consumed:?}");
        assert!(
            !consumed.body.contains("response.completed"),
            "{consumed:?}"
        );
        assert!(
            !consumed.body.contains("PRIVATE_REASONING_E63"),
            "{consumed:?}"
        );
        assert_one_attempt(&mut captures, "wire-test").await;
    }
    std::env::remove_var(KEY_ENV);
}

async fn issue0ff6700_run(process: &str, stream: bool, recover: bool) {
    issue0ff6700_run_body(process, stream, recover, None).await;
}

async fn issue0ff6700_run_body(
    process: &str,
    stream: bool,
    recover: bool,
    blank_body: Option<String>,
) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let encode = |body: &Value| {
        if stream {
            response_sse(body)
        } else {
            body.to_string()
        }
    };
    let blank = issue0ff6700_blank_final();
    let blank_body = blank_body.unwrap_or_else(|| encode(&blank));
    let options = EntryOptions {
        attempt_bodies: if recover {
            vec![blank_body.clone(), encode(&text_response("RECOVERED_0FF"))]
        } else {
            Vec::new()
        },
        auth_entries: if recover {
            vec![
                ("first".into(), KEY_ENV.into()),
                ("second".into(), KEY_ENV.into()),
            ]
        } else {
            Vec::new()
        },
        ..EntryOptions::default()
    };
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        process,
        StatusCode::OK,
        if stream {
            "text/event-stream"
        } else {
            "application/json"
        },
        blank_body,
        options,
    )
    .await;
    let response = client()
        .post(&endpoint)
        .json(&json!({"model":"test.test","input":"controlled blank final","stream":stream}))
        .send()
        .await;
    let consumed = consume_response(response).await;
    let attempts = std::iter::from_fn(|| captures.try_recv().ok()).count();
    if !recover {
        let base = endpoint.trim_end_matches("/v1/responses");
        let health: Value = client()
            .get(format!("{base}/_routecodex/health/cooldown-pool"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            health["entries"].as_array().unwrap().is_empty(),
            "last candidate must not cool: {health}"
        );
        let next = consume_response(
            client()
                .post(&endpoint)
                .json(&json!({"model":"test.test","input":"new blank request","stream":stream}))
                .send()
                .await,
        )
        .await;
        assert!(
            next.transport_error.is_some(),
            "next request must still fail detectably: {next:?}"
        );
        assert_eq!(
            std::iter::from_fn(|| captures.try_recv().ok()).count(),
            1,
            "new request must try the same uncooled candidate once"
        );
    }
    stop_entry(handle, shutdown).await;
    std::env::remove_var(KEY_ENV);
    assert_eq!(
        attempts,
        if recover { 2 } else { 1 },
        "whole-attempt candidate count: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("PRIVATE_THOUGHT_0FF"),
        "discard the complete blank attempt: {consumed:?}"
    );
    if recover {
        assert!(
            consumed.transport_error.is_none() && consumed.body.contains("RECOVERED_0FF"),
            "next candidate must supply visible business: {consumed:?}"
        );
    } else {
        assert!(
            consumed.transport_error.is_some(),
            "blank exhaustion cannot complete normally: {consumed:?}"
        );
        assert!(!consumed.body.contains("response.completed") && !consumed.body.contains("[DONE]"));
    }
    assert!(
        !consumed.body.contains("provider_response_empty") && !consumed.body.contains("\"error\"")
    );
}

#[tokio::test]
async fn issue0ff6700_direct_json_recovers() {
    issue0ff6700_run("direct", false, true).await;
}
#[tokio::test]
async fn issue0ff6700_direct_sse_recovers() {
    issue0ff6700_run("direct", true, true).await;
}
#[tokio::test]
async fn issue0ff6700_relay_json_recovers() {
    issue0ff6700_run("relay", false, true).await;
}
#[tokio::test]
async fn issue0ff6700_relay_sse_recovers() {
    issue0ff6700_run("relay", true, true).await;
}
#[tokio::test]
async fn issue0ff6700_direct_json_exhausts() {
    issue0ff6700_run("direct", false, false).await;
}
#[tokio::test]
async fn issue0ff6700_direct_sse_exhausts() {
    issue0ff6700_run("direct", true, false).await;
}
#[tokio::test]
async fn issue0ff6700_relay_json_exhausts() {
    issue0ff6700_run("relay", false, false).await;
}
#[tokio::test]
async fn issue0ff6700_relay_sse_exhausts() {
    issue0ff6700_run("relay", true, false).await;
}

async fn issuec1090f9_invisible_final_recovers(process: &str, stream: bool, final_text: &str) {
    issue0ff6700_run_body(
        process,
        stream,
        true,
        Some(issuec1090f9_body(stream, final_text)),
    )
    .await;
}

fn issuec1090f9_body(stream: bool, final_text: &str) -> String {
    let mut response = issue0ff6700_blank_final();
    response["output"][1]["content"][0]["text"] = final_text.into();
    if stream {
        response_sse(&response)
    } else {
        response.to_string()
    }
}

#[tokio::test]
async fn issuec1090f9_direct_json_zero_width_final_recovers() {
    issuec1090f9_invisible_final_recovers("direct", false, "\u{200b}").await;
}

#[tokio::test]
async fn issuec1090f9_relay_sse_byte_order_mark_final_recovers() {
    issuec1090f9_invisible_final_recovers("relay", true, "\u{feff}").await;
}

#[tokio::test]
async fn issuec1090f9_empty_final_switches_provider_and_returns_business() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["direct", "relay"] {
        for stream in [false, true] {
            let first = issuec1090f9_body(stream, "\u{200b}");
            let recovered = text_response("RECOVERED_DIFFERENT_PROVIDER_C1090F9");
            let second = if stream {
                response_sse(&recovered)
            } else {
                recovered.to_string()
            };
            let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
                "responses",
                process,
                StatusCode::OK,
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                first.clone(),
                EntryOptions {
                    attempt_bodies: vec![first, second],
                    two_provider_route: true,
                    ..EntryOptions::default()
                },
            )
            .await;
            let consumed = consume_response(
                client()
                    .post(&endpoint)
                    .json(&json!({"model":"router-test","input":"recover invisible output using another provider","stream":stream}))
                    .send()
                    .await,
            )
            .await;
            let attempts: Vec<_> = std::iter::from_fn(|| captures.try_recv().ok()).collect();
            stop_entry(handle, shutdown).await;
            assert_eq!(
                attempts.len(),
                2,
                "must dispatch exactly two providers: {consumed:?}"
            );
            assert_eq!(attempts[0]["model"], "wire-test");
            assert_eq!(attempts[1]["model"], "wire-independent");
            assert!(
                consumed.transport_error.is_none(),
                "provider recovery must complete: {process} stream={stream}: {consumed:?}"
            );
            assert!(consumed
                .body
                .contains("RECOVERED_DIFFERENT_PROVIDER_C1090F9"));
            assert!(!consumed.body.contains("PRIVATE_THOUGHT_0FF"));
            assert!(!consumed.body.contains("provider_response_empty"));
            assert!(!consumed.body.contains('\u{200b}'));
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn issuec1090f9_remaining_paths_and_last_candidate() {
    for (process, stream) in [("direct", true), ("relay", false)] {
        issuec1090f9_invisible_final_recovers(process, stream, "\u{200e}\u{202e}\u{2060}\u{fe0f}")
            .await;
    }
    for process in ["direct", "relay"] {
        for stream in [false, true] {
            issue0ff6700_run_body(
                process,
                stream,
                false,
                Some(issuec1090f9_body(stream, " \u{200b}\u{feff}\u{0000}\n")),
            )
            .await;
        }
    }
}

#[tokio::test]
async fn issuec1090f9_visible_unicode_preserves_exact_text() {
    issuec1090f9_visible_text_preserved(
        "中文 العربية देवनागरी e\u{0301} 👩\u{200d}💻 ☀\u{fe0f} A\u{200b}B\u{feff}C\u{202e}D",
    )
    .await;
}

#[tokio::test]
async fn issuec1090f9_visible_cf_ayah_mark_preserved() {
    issuec1090f9_visible_text_preserved("\u{06dd}").await;
}

#[tokio::test]
async fn issuec1090f9_visible_cf_number_sign_preserved() {
    issuec1090f9_visible_text_preserved("\u{0600}").await;
}

async fn issuec1090f9_visible_text_preserved(text: &str) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let body = text_response(text);
    for process in ["direct", "relay"] {
        for stream in [false, true] {
            let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
                "responses",
                process,
                StatusCode::OK,
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                if stream {
                    response_sse(&body)
                } else {
                    body.to_string()
                },
                EntryOptions::default(),
            )
            .await;
            let consumed = consume_response(client().post(&endpoint).json(&json!({"model":"test.test","input":"controlled visible unicode","stream":stream})).send().await).await;
            assert!(consumed.transport_error.is_none(), "visible business must survive: {process} stream={stream} text={text:?}: {consumed:?}");
            let received: Value = if stream {
                consumed
                    .body
                    .lines()
                    .filter_map(|line| line.strip_prefix("data: "))
                    .filter_map(|data| serde_json::from_str::<Value>(data).ok())
                    .find(|event| event["type"] == "response.completed")
                    .expect("legal terminal")["response"]
                    .clone()
            } else {
                serde_json::from_str(&consumed.body).unwrap()
            };
            assert_eq!(
                received["output"][0]["content"][0]["text"], text,
                "{process} stream={stream} must preserve every scalar"
            );
            assert_eq!(std::iter::from_fn(|| captures.try_recv().ok()).count(), 1);
            stop_entry(handle, shutdown).await;
        }
    }
    std::env::remove_var(KEY_ENV);
}

fn issue0ff6700_fragmented_blank() -> String {
    let response = issue0ff6700_blank_final();
    format!(
        "{}{}{}{}{}",
        sse(
            "response.output_item.done",
            &json!({"type":"response.output_item.done","output_index":0,"item":response["output"][0]})
        ),
        sse(
            "response.output_item.added",
            &json!({"type":"response.output_item.added","output_index":1,"item":{"id":"blank_message","type":"message","role":"assistant","content":[]}})
        ),
        sse(
            "response.output_text.delta",
            &json!({"type":"response.output_text.delta","item_id":"blank_message","output_index":1,"content_index":0,"delta":"\n\n\n\n"})
        ),
        sse(
            "response.output_text.done",
            &json!({"type":"response.output_text.done","item_id":"blank_message","output_index":1,"content_index":0,"text":"\n\n\n\n"})
        ),
        response_sse(
            &json!({"id":"fragmented_blank","object":"response","status":"completed","output":[]})
        )
    )
}

#[tokio::test]
async fn issue0ff6700_direct_fragmented_blank_recovers() {
    issue0ff6700_run_body("direct", true, true, Some(issue0ff6700_fragmented_blank())).await;
}
#[tokio::test]
async fn issue0ff6700_relay_fragmented_blank_recovers() {
    issue0ff6700_run_body("relay", true, true, Some(issue0ff6700_fragmented_blank())).await;
}

#[tokio::test]
async fn issue0ff6700_independent_business_controls_survive() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let blank = issue0ff6700_blank_final();
    let mut reasoning = blank.clone();
    reasoning["output"].as_array_mut().unwrap().pop();
    reasoning["output"]
        .as_array_mut()
        .unwrap()
        .push(text_response("visible answer alongside reasoning")["output"][0].clone());
    let mut tool = blank.clone();
    tool["output"].as_array_mut().unwrap().push(json!({"type":"function_call","id":"tool_0ff","call_id":"call_0ff","name":"lookup","arguments":"{invalid model arguments"}));
    let mut refusal = blank.clone();
    refusal["output"][1]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"refusal","refusal":"declined"}));
    let mut filtered = blank.clone();
    filtered["status"] = json!("incomplete");
    filtered["incomplete_details"] = json!({"reason":"content_filter"});
    let mut opaque = blank.clone();
    opaque["output"].as_array_mut().unwrap().push(json!({"type":"mcp_call","id":"opaque_0ff","server_label":"opaque","name":"lookup","arguments":"{}","output":"done","status":"completed","vendor_payload":{"ok":true}}));
    for process in ["direct", "relay"] {
        for stream in [false, true] {
            for response in [
                &reasoning,
                &tool,
                &refusal,
                &filtered,
                &opaque,
                &text_response("visible answer"),
            ] {
                let body = if stream {
                    response_sse(response)
                } else {
                    response.to_string()
                };
                let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
                    "responses",
                    process,
                    StatusCode::OK,
                    if stream {
                        "text/event-stream"
                    } else {
                        "application/json"
                    },
                    body,
                    EntryOptions::default(),
                )
                .await;
                let consumed = consume_response(client().post(&endpoint).json(&json!({"model":"test.test","input":"controlled business","stream":stream})).send().await).await;
                let attempts = std::iter::from_fn(|| captures.try_recv().ok()).count();
                stop_entry(handle, shutdown).await;
                assert_eq!(attempts, 1);
                assert!(
                    consumed.transport_error.is_none(),
                    "{process} stream={stream} control={response}: {consumed:?}"
                );
                assert!(!consumed.body.contains("provider_response_empty"));
                if response == &opaque {
                    assert!(
                        consumed.body.contains("opaque_0ff")
                            && consumed.body.contains("vendor_payload"),
                        "independent opaque business must survive: {consumed:?}"
                    );
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

struct ProviderState {
    kind: String,
    health_enabled: bool,
    status_override: Option<StatusCode>,
    status: StatusCode,
    content_type: &'static str,
    body: String,
    captures: mpsc::UnboundedSender<Value>,
    mixed: Option<MixedRoundtrip>,
    attempt_bodies: Vec<String>,
    attempts: std::sync::atomic::AtomicUsize,
    attempt_statuses: Vec<StatusCode>,
    header_captures: Option<mpsc::UnboundedSender<String>>,
    live_forward: Option<LiveForward>,
    hold_attempt_open: bool,
}

struct LiveForward {
    client: reqwest::Client,
    target: String,
    captures: Arc<std::sync::Mutex<Vec<LiveForwardExchange>>>,
}

#[derive(Clone)]
struct LiveForwardExchange {
    request_body: Vec<u8>,
    response_status: Option<StatusCode>,
    response_content_type: Option<String>,
    response_body: Vec<u8>,
    transport_error: Option<String>,
}

impl Default for LiveForwardExchange {
    fn default() -> Self {
        Self {
            request_body: Vec::new(),
            response_status: None,
            response_content_type: None,
            response_body: Vec::new(),
            transport_error: None,
        }
    }
}

/// Explicit Anthropic SSE failures must stay failures at the public entry.
/// This covers the user-reported risk: an explicit provider error or an
/// underterminated Anthropic message must not become `response.completed` with
/// empty output. The provider payload is deliberately not returned to clients.
#[tokio::test]
async fn anthropic_relay_explicit_error_and_missing_stop_break_transport_without_fake_completion() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream_marker = "provider_private.explicit_empty_failure_marker";
    let failures = [
        format!(
            "{}{}",
            sse(
                "message_start",
                &json!({
                    "type": "message_start",
                    "message": {
                        "id": "msg_explicit_failure",
                        "type": "message",
                        "role": "assistant",
                        "model": "wire-test",
                        "content": [],
                        "stop_reason": null,
                        "usage": {"input_tokens": 1, "output_tokens": 0}
                    }
                })
            ),
            sse(
                "error",
                &json!({
                    "type": "error",
                    "error": {"type": "provider_empty_failure", "message": upstream_marker}
                })
            )
        ),
        format!(
            "{}{}{}",
            sse(
                "message_start",
                &json!({
                    "type": "message_start",
                    "message": {
                        "id": "msg_missing_stop",
                        "type": "message",
                        "role": "assistant",
                        "model": "wire-test",
                        "content": [],
                        "stop_reason": null,
                        "usage": {"input_tokens": 1, "output_tokens": 0}
                    }
                })
            ),
            sse(
                "content_block_start",
                &json!({
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""}
                })
            ),
            sse(
                "content_block_delta",
                &json!({
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "partial before EOF"}
                })
            )
        ),
    ];

    for (index, upstream) in failures.into_iter().enumerate() {
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "anthropic",
            "chat",
            StatusCode::OK,
            "text/event-stream",
            upstream,
        )
        .await;
        let client = client();
        assert_incomplete_transport(post_request(&client, &endpoint, "test.test").await).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let independent =
            successful_body(post_request(&client, &endpoint, "independent.test").await).await;
        let independent_events = events(&independent);
        let independent_terminal = independent_events
            .iter()
            .find(|event| event["type"] == "response.completed")
            .unwrap_or_else(|| {
                panic!("independent candidate index {index} must complete: {independent}")
            });
        assert_eq!(
            independent_terminal["response"]["output"],
            text_response("independent ok")["output"]
        );
        stop_entry(handle, shutdown).await;
    }
    std::env::remove_var(KEY_ENV);
}

mod empty_attempt_adjudication_blackbox {
    use super::*;

    /// Whole-attempt emptiness is judged by accumulated business content, not
    /// by the last terminal frame. A Responses stream that already carried a
    /// text delta must keep that text and its successful terminal even when the
    /// provider's terminal `response.completed` carries `output:[]`.
    #[tokio::test]
    async fn responses_prior_business_delta_survives_empty_terminal() {
        let _guard = TEST_LOCK.lock().await;
        std::env::set_var(KEY_ENV, "controlled-secret");
        let upstream = format!(
            "{}{}",
            sse(
                "response.output_text.delta",
                &json!({"type":"response.output_text.delta","output_index":0,"delta":"kept"}),
            ),
            response_sse(&json!({"status":"completed","output":[],
                "usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}})),
        );
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            "text/event-stream",
            upstream,
        )
        .await;
        let (content_type, body) =
            successful_transfer(post_request(&client(), &endpoint, "test.test").await).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        stop_entry(handle, shutdown).await;
        assert!(
            content_type.starts_with("text/event-stream"),
            "Relay projects the requested SSE: {body}"
        );
        let payloads = events(&body);
        assert!(
            payloads
                .iter()
                .any(|event| event["type"] == "response.completed"),
            "a prior business delta must keep the successful terminal, not be \
             reclassified as an empty attempt: {body}"
        );
        let terminal = payloads
            .iter()
            .find(|event| event["type"] == "response.completed")
            .unwrap();
        let terminal_response = &terminal["response"];
        let output = terminal_response["output"].clone();
        let output_is_empty = output.as_array().is_none_or(|items| items.is_empty());
        let output_text = terminal_response["output_text"]
            .as_str()
            .unwrap_or_default();
        assert!(
            !output_is_empty || !output_text.is_empty(),
            "the terminal frame's empty output must not erase the accumulated delta: {body}"
        );
        assert!(
            output.to_string().contains("kept") || output_text.contains("kept"),
            "accumulated business delta must reach the client: {body}"
        );
        std::env::remove_var(KEY_ENV);
    }

    /// Complete Direct/JSON empty provider attempts must take the same internal
    /// 502 path: client transport abort, no normal completion and no error
    /// payload. Legal Direct business content keeps its own positive controls.
    #[tokio::test]
    async fn responses_direct_and_relay_empty_json_attempt_is_internal_502() {
        let _guard = TEST_LOCK.lock().await;
        std::env::set_var(KEY_ENV, "controlled-secret");
        for process in ["direct", "chat"] {
            let empty = json!({"id":"resp_empty_json","object":"response","status":"completed",
                "model":"wire-test","output":[]});
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                process,
                StatusCode::OK,
                "application/json",
                empty.to_string(),
            )
            .await;
            assert_incomplete_transport(post_request(&client(), &endpoint, "test.test").await)
                .await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let body =
                successful_body(post_request(&client(), &endpoint, "independent.test").await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-independent").await;
            let payloads = events(&body);
            let terminal = payloads
                .iter()
                .find(|event| event["type"] == "response.completed")
                .expect("independent request completes");
            assert_eq!(
                terminal["response"]["output"],
                text_response("independent ok")["output"]
            );
        }
        std::env::remove_var(KEY_ENV);
    }

    /// Explicit Anthropic `stop_reason=refusal` is a legal business terminal
    /// even with an empty text array. It must keep its refusal details and
    /// content_filter reason instead of being reclassified as an empty attempt.
    #[tokio::test]
    async fn anthropic_empty_text_refusal_keeps_business_terminal() {
        let _guard = TEST_LOCK.lock().await;
        std::env::set_var(KEY_ENV, "controlled-secret");
        let upstream = [
            sse(
                "message_start",
                &json!({"type":"message_start","message":{"id":"msg_refusal_empty","type":"message",
                    "role":"assistant","model":"wire-test","content":[],
                    "stop_reason":null,"stop_details":null,
                    "usage":{"input_tokens":7,"output_tokens":0}}}),
            ),
            sse(
                "message_delta",
                &json!({"type":"message_delta",
                    "delta":{"stop_reason":"refusal","stop_sequence":null,
                        "stop_details":{"type":"refusal","category":"cyber"}},
                    "usage":{"output_tokens":0}}),
            ),
            sse("message_stop", &json!({"type":"message_stop"})),
        ]
        .concat();
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "anthropic",
            "chat",
            StatusCode::OK,
            "text/event-stream",
            upstream,
        )
        .await;
        let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let payloads = events(&body);
        let terminal = payloads
            .iter()
            .find(|event| event["type"] == "response.incomplete")
            .expect("Anthropic refusal maps to incomplete/content_filter");
        assert_eq!(
            terminal["response"]["incomplete_details"]["reason"],
            "content_filter"
        );
        assert_eq!(
            terminal["response"]["stop_details"],
            json!({"type":"refusal","category":"cyber"}),
            "empty-text refusal must keep its refusal details: {body}"
        );
        assert!(
            !payloads
                .iter()
                .any(|event| event["type"] == "response.completed"),
            "refusal must not become a completed turn: {body}"
        );
        std::env::remove_var(KEY_ENV);
    }
}

/// Stable RED ID: a complete Anthropic success with no business content
/// (`message_start content:[] -> end_turn -> message_stop`) is not deliverable.
/// It must become an internal 502 in the Error chain and terminate the client
/// transport, never a normal empty `response.completed`.
#[tokio::test]
async fn anthropic_relay_empty_success_is_internal_502_not_normal_completion() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let provider_wire = anthropic_empty_success_sse("msg_empty_success");
    let (endpoint, handle, mut captures, _headers, shutdown) = start_entry_configured(
        "anthropic",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        provider_wire.clone(),
        EntryOptions::default(),
    )
    .await;
    let consumed = consume_response(post_request(&client(), &endpoint, "test.test").await).await;
    eprintln!("EMPTY_SUCCESS provider_wire={provider_wire:?}");
    eprintln!(
        "EMPTY_SUCCESS client status={:?} version={:?} transport_error={:?} body={:?}",
        consumed.status, consumed.version, consumed.transport_error, consumed.body
    );
    assert_one_attempt(&mut captures, "wire-test").await;
    stop_entry(handle, shutdown).await;
    assert!(
        consumed.transport_error.is_some(),
        "an empty complete provider attempt must terminate the client transport, not return a normal empty completion: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("response.completed"),
        "an empty complete provider attempt must not become response.completed: {:?}",
        consumed.body
    );
    assert!(
        !consumed.body.contains("\"error\"")
            && !consumed.body.contains("event: error")
            && !consumed.body.contains("network_error"),
        "the internal 502 must not be projected to the client: {:?}",
        consumed.body
    );
    std::env::remove_var(KEY_ENV);
}

/// Stable RED ID: one selected target expands its two auth aliases into two
/// candidates. An empty first attempt must enter the internal 502 path and the
/// healthy second candidate must deliver its business content to the client.
#[tokio::test]
async fn anthropic_relay_empty_attempt_reselects_healthy_within_target_candidate() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var("V3_NO_RESPONSE_TEST_KEY_A", "empty-key-secret");
    std::env::set_var("V3_NO_RESPONSE_TEST_KEY_B", "healthy-key-secret");
    let options = EntryOptions {
        attempt_bodies: vec![
            anthropic_empty_success_sse("msg_empty_first"),
            anthropic_text_sse("msg_healthy_second", "healthy candidate recovered"),
        ],
        auth_entries: vec![
            ("key-a".to_string(), "V3_NO_RESPONSE_TEST_KEY_A".to_string()),
            ("key-b".to_string(), "V3_NO_RESPONSE_TEST_KEY_B".to_string()),
        ],
        pin_key: None,
        capture_headers: true,
        ..EntryOptions::default()
    };
    let (endpoint, handle, mut captures, headers, shutdown) = start_entry_configured(
        "anthropic",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        String::new(),
        options,
    )
    .await;
    let mut headers = headers.expect("recovery fixture must capture provider auth headers");
    let consumed = consume_response(post_request(&client(), &endpoint, "test.test").await).await;
    let capture_count = captures.len();
    let first_auth = headers
        .try_recv()
        .expect("first provider auth header captured");
    let second_auth = headers.try_recv().ok();
    let first_request = captures.try_recv().ok();
    let second_request = captures.try_recv().ok();
    let extra_request = captures.try_recv().ok();
    eprintln!(
        "RECOVERY client status={:?} version={:?} transport_error={:?} captures={capture_count} first_auth={first_auth:?} second_auth={second_auth:?} body={:?}",
        consumed.status,
        consumed.version,
        consumed.transport_error,
        consumed.body
    );
    stop_entry(handle, shutdown).await;
    assert!(
        consumed.body.contains("healthy candidate recovered"),
        "the healthy second candidate must deliver business content: {:?}",
        consumed.body
    );
    assert!(
        consumed.transport_error.is_none(),
        "the recovered request must not end in a transport error: {:?}",
        consumed.body
    );
    let second_auth = second_auth.expect("a second within-target candidate attempt must occur");
    assert_ne!(
        first_auth, second_auth,
        "recovery must use the other auth key of the same selected target"
    );
    let first_request = first_request.expect("first provider request captured");
    let second_request = second_request.expect("second provider request captured");
    assert_eq!(first_request["model"], "wire-test");
    assert_eq!(second_request["model"], "wire-test");
    assert!(
        extra_request.is_none(),
        "exactly two within-target attempts are expected"
    );
    std::env::remove_var("V3_NO_RESPONSE_TEST_KEY_A");
    std::env::remove_var("V3_NO_RESPONSE_TEST_KEY_B");
    std::env::remove_var(KEY_ENV);
}

/// 5338ac6: the first complete attempt becomes empty only after memory stripping.
/// A legal closeout must not commit that attempt instead of trying the next key.
#[tokio::test]
async fn direct_sse_memory_only_reselects_before_client_commit() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let options = EntryOptions {
        memory_project_root: Some(
            std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join("capture"),
        ),
        attempt_bodies: vec![
            format!(
                "{}data: [DONE]\n\n",
                response_sse(&text_response(r#"{"memory":{"entries":[]}}"#))
            ),
            response_sse(&text_response("Recovered visible answer.")),
        ],
        auth_entries: vec![
            ("first".into(), KEY_ENV.into()),
            ("second".into(), KEY_ENV.into()),
        ],
        ..EntryOptions::default()
    };
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        "direct",
        StatusCode::OK,
        "text/event-stream",
        String::new(),
        options,
    )
    .await;
    let consumed = consume_response(post_request(&client(), &endpoint, "test.test").await).await;
    let attempts = std::iter::from_fn(|| captures.try_recv().ok()).collect::<Vec<_>>();
    stop_entry(handle, shutdown).await;
    assert!(
        consumed.body.contains("Recovered visible answer."),
        "post-rewrite empty attempt must recover: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "recovered transport must complete: {consumed:?}"
    );
    assert_eq!(attempts.len(), 2, "must try the second eligible candidate");
    assert!(attempts
        .iter()
        .all(|request| request["model"] == "wire-test"));
    assert!(
        !consumed.body.contains("\"memory\"") && !consumed.body.contains("provider_response_empty"),
        "internal content must not reach client: {consumed:?}"
    );
    std::env::remove_var(KEY_ENV);
}

/// 5338ac6: terminal/EOF without legal closeout must also recheck after stripping.
#[tokio::test]
async fn direct_sse_memory_only_exhaustion_interrupts_transport() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let options = EntryOptions {
        memory_project_root: Some(
            std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join("capture"),
        ),
        ..EntryOptions::default()
    };
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        "direct",
        StatusCode::OK,
        "text/event-stream",
        response_sse(&text_response(r#"{"memory":{"entries":[]}}"#)),
        options,
    )
    .await;
    let consumed = consume_response(post_request(&client(), &endpoint, "test.test").await).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    stop_entry(handle, shutdown).await;
    assert!(
        consumed.transport_error.is_some(),
        "memory-only exhaustion must interrupt transport: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("response.completed") && !consumed.body.contains("[DONE]"),
        "must not deliver normal empty completion: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("\"error\"")
            && !consumed.body.contains("provider_response_empty")
            && !consumed.body.contains("502"),
        "internal errors must not reach client: {consumed:?}"
    );
    std::env::remove_var(KEY_ENV);
}

/// 5338ac6: stripping non-client text must preserve every other business carrier.
#[tokio::test]
async fn direct_sse_memory_rewrite_preserves_business_results() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let envelope = r#"{"memory":{"entries":[]}}"#;
    let cases = [
        ("text", None, "Visible answer."),
        (
            "tool",
            Some(
                json!({"type":"function_call","id":"fc_memory","call_id":"call_memory","name":"lookup","arguments":"{invalid"}),
            ),
            "call_memory",
        ),
        (
            "reasoning",
            Some(
                json!({"type":"reasoning","id":"rs_memory","summary":[{"type":"summary_text","text":"Preserved reasoning."}]}),
            ),
            "Preserved reasoning.",
        ),
        (
            "refusal",
            Some(
                json!({"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"Preserved refusal."}]}),
            ),
            "Preserved refusal.",
        ),
        ("filter", None, "content_filter"),
    ];
    for (kind, extra, expected) in cases {
        let text = if kind == "text" || kind == "reasoning" {
            format!("Visible answer. {envelope}")
        } else {
            envelope.into()
        };
        let mut response = text_response(&text);
        let mut prior_business = String::new();
        if let Some(extra) = extra {
            if kind == "tool" {
                // Whole-attempt admission must preserve earlier tool output
                // even when the terminal snapshot contains only memory text.
                prior_business = sse(
                    "response.output_item.done",
                    &json!({"type":"response.output_item.done","output_index":1,"item":extra}),
                );
            } else {
                response["output"].as_array_mut().unwrap().push(extra);
            }
        }
        let wire = if kind == "filter" {
            response["status"] = json!("incomplete");
            response["incomplete_details"] = json!({"reason":"content_filter"});
            response["output"] = json!([]);
            // Incomplete terminals do not request memory capture; the filter
            // outcome itself remains a deliverable result with no text.
            response_sse(&response)
        } else {
            format!("{prior_business}{}", response_sse(&response))
        };
        let options = EntryOptions {
            memory_project_root: Some(
                std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join("capture"),
            ),
            ..EntryOptions::default()
        };
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            "direct",
            StatusCode::OK,
            "text/event-stream",
            wire,
            options,
        )
        .await;
        let consumed =
            consume_response(post_request(&client(), &endpoint, "test.test").await).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        stop_entry(handle, shutdown).await;
        assert!(
            consumed.transport_error.is_none(),
            "{kind} must remain deliverable: {consumed:?}"
        );
        assert!(
            consumed.body.contains(expected),
            "{kind} business result lost: {consumed:?}"
        );
        assert!(
            !consumed.body.contains("\\\"memory\\\""),
            "internal memory leaked in {kind}: {consumed:?}"
        );
        if kind == "tool" {
            assert!(
                consumed.body.contains("{invalid"),
                "opaque model arguments must pass"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// Normal Responses SSE snapshots that carry only the declared memory
/// envelope. The whole-attempt judgment must strip these carriers exactly like
/// the terminal snapshot so an internal memory unit cannot authorize client
/// completion.
fn responses_memory_item_part_sequence(envelope: &str) -> String {
    let item = json!({
        "id":"msg_memory_item_guard",
        "type":"message",
        "role":"assistant",
        "status":"completed",
        "content":[{"type":"output_text","text":envelope,"annotations":[]}]
    });
    let part = json!({"type":"output_text","text":envelope,"annotations":[]});
    format!(
        "{}{}{}{}{}{}{}",
        sse(
            "response.output_item.added",
            &json!({"type":"response.output_item.added","output_index":0,"item":item.clone()})
        ),
        sse(
            "response.content_part.added",
            &json!({"type":"response.content_part.added","output_index":0,"content_index":0,
                "part":part.clone()})
        ),
        sse(
            "response.output_text.delta",
            &json!({"type":"response.output_text.delta","output_index":0,"content_index":0,
                "delta":envelope})
        ),
        sse(
            "response.output_text.done",
            &json!({"type":"response.output_text.done","output_index":0,"content_index":0,
                "text":envelope})
        ),
        sse(
            "response.content_part.done",
            &json!({"type":"response.content_part.done","output_index":0,"content_index":0,
                "part":part})
        ),
        sse(
            "response.output_item.done",
            &json!({"type":"response.output_item.done","output_index":0,"item":item})
        ),
        response_sse(&text_response(envelope)),
    )
}

/// P1A: memory carried only in normal output_item/content_part snapshots must
/// be stripped before whole-attempt adjudication, at both the legal-closeout
/// and terminal/EOF seal exits. A memory-only attempt must reselect or
/// detectably exhaust, and it must never leak the envelope or deliver a normal
/// empty completion.
#[tokio::test]
async fn direct_sse_memory_item_part_sequences_never_authorize_completion() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let envelope = r#"{"memory":{"entries":[]}}"#;
    let memory_sequence = responses_memory_item_part_sequence(envelope);
    for (exit, closeout, recover) in [
        ("legal_closeout", true, true),
        ("legal_closeout", true, false),
        ("terminal_eof", false, true),
        ("terminal_eof", false, false),
    ] {
        let memory_wire = if closeout {
            format!("{memory_sequence}data: [DONE]\n\n")
        } else {
            memory_sequence.clone()
        };
        let memory_root =
            std::env::temp_dir().join(format!("rcc-memory-item-part-{exit}-{recover}"));
        let options = EntryOptions {
            memory_project_root: Some(memory_root.clone()),
            attempt_bodies: if recover {
                vec![
                    memory_wire.clone(),
                    response_sse(&text_response("Recovered visible answer.")),
                ]
            } else {
                Vec::new()
            },
            auth_entries: if recover {
                vec![
                    ("first".into(), KEY_ENV.into()),
                    ("second".into(), KEY_ENV.into()),
                ]
            } else {
                Vec::new()
            },
            ..EntryOptions::default()
        };
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            "direct",
            StatusCode::OK,
            "text/event-stream",
            if recover { String::new() } else { memory_wire },
            options,
        )
        .await;
        let consumed =
            consume_response(post_request(&client(), &endpoint, "test.test").await).await;
        if recover {
            let attempts = std::iter::from_fn(|| captures.try_recv().ok()).collect::<Vec<_>>();
            stop_entry(handle, shutdown).await;
            assert!(
                consumed.body.contains("Recovered visible answer."),
                "{exit}: memory-only attempt must reselect: {consumed:?}"
            );
            assert!(
                consumed.transport_error.is_none(),
                "{exit}: recovered transport must complete: {consumed:?}"
            );
            assert_eq!(
                attempts.len(),
                2,
                "{exit}: second eligible candidate must be tried"
            );
            assert!(
                !consumed.body.contains("msg_memory_item_guard"),
                "{exit}: memory-only attempt must not commit: {consumed:?}"
            );
        } else {
            assert_one_attempt(&mut captures, "wire-test").await;
            stop_entry(handle, shutdown).await;
            assert!(
                consumed.transport_error.is_some(),
                "{exit}: memory-only exhaustion must interrupt transport: {consumed:?}"
            );
            assert!(
                !consumed.body.contains("response.completed") && !consumed.body.contains("[DONE]"),
                "{exit}: must not deliver a normal empty completion: {consumed:?}"
            );
        }
        assert!(
            !consumed.body.contains("\"memory\"") && !consumed.body.contains("\"entries\""),
            "{exit}: internal memory must not reach client: {consumed:?}"
        );
        assert!(
            !consumed.body.contains("provider_response_empty") && !consumed.body.contains("502"),
            "{exit}: internal error must not reach client: {consumed:?}"
        );
        let _ = std::fs::remove_dir_all(&memory_root);
    }
    std::env::remove_var(KEY_ENV);
}

/// A tool-only Anthropic terminal has no text but still carries business
/// content. It must remain a normal completion and must not be classified as
/// the empty attempt above.
#[tokio::test]
async fn anthropic_relay_tool_only_terminal_stays_deliverable() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let provider_wire = anthropic_tool_only_sse("msg_tool_only_guard");
    let (endpoint, handle, mut captures, _headers, shutdown) = start_entry_configured(
        "anthropic",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        provider_wire,
        EntryOptions::default(),
    )
    .await;
    let (content_type, body) =
        successful_transfer(post_request(&client(), &endpoint, "test.test").await).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    stop_entry(handle, shutdown).await;
    assert!(content_type.starts_with("text/event-stream"));
    let payloads = events(&body);
    let terminal = payloads
        .iter()
        .find(|event| event["type"] == "response.completed")
        .expect("tool-only attempt must complete");
    let output = terminal["response"]["output"]
        .as_array()
        .expect("completed response output array");
    assert!(
        output
            .iter()
            .any(|item| item["type"] == "function_call" && item["name"] == "lookup"),
        "tool-only business content must survive: {body}"
    );
    assert!(
        body.contains("guard"),
        "tool-only arguments must survive: {body}"
    );
    std::env::remove_var(KEY_ENV);
}

/// Read the projected Responses payload at the public client boundary, whether
/// the fixture returned compact JSON or an SSE stream.
fn client_responses_payload(body: &str) -> Value {
    if let Some(response) = events(body).iter().find_map(|event| {
        matches!(
            event["type"].as_str(),
            Some("response.completed" | "response.done" | "response.incomplete")
        )
        .then(|| event["response"].clone())
    }) {
        return response;
    }
    serde_json::from_str(body)
        .unwrap_or_else(|error| panic!("client body must be Responses payload: {error}: {body}"))
}

/// P1B: the Anthropic→Responses normalization owner must preserve ordinary
/// opaque root business fields that expanded admission now allows, while
/// consuming only the explicitly mapped Anthropic message fields. The tool
/// identity and the matched prior history stay intact at the same public
/// cross-protocol boundary.
#[tokio::test]
async fn anthropic_json_business_root_fields_survive_responses_client_projection() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let provider_body = json!({
        "id":"msg_business_opaque","type":"message","role":"assistant","model":"wire-test",
        "content":[
            {"type":"text","text":"opaque business result"},
            {"type":"tool_use","id":"toolu_opaque","name":"lookup","input":{"q":"opaque"}}
        ],
        "stop_reason":"tool_use","stop_sequence":null,
        "usage":{"input_tokens":5,"output_tokens":4},
        "metadata_center":{"business":"kept"},
        "requiredCapabilities":["alpha","beta"],
        "routecodex_internal":{"nested":{"list":[1,2,3]}}
    })
    .to_string();
    let request = json!({
        "model":"test.test","stream":false,
        "input":[
            {"type":"message","role":"user","content":"run the opaque check"},
            {"type":"function_call","call_id":"call_history","name":"lookup",
                "arguments":"{\"q\":\"history\"}"},
            {"type":"function_call_output","call_id":"call_history","output":"history result"}
        ]
    });
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "anthropic",
        "chat",
        StatusCode::OK,
        "application/json",
        provider_body,
    )
    .await;
    let (_, client_body) =
        successful_transfer(client().post(&endpoint).json(&request).send().await).await;
    let captured = tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .expect("real upstream attempt")
        .unwrap();
    assert!(
        matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ),
        "exactly one upstream attempt"
    );
    stop_entry(handle, shutdown).await;

    // History protection: the matched tool result survives request projection.
    let history = captured["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|part| part["type"] == "tool_result")
        .unwrap_or_else(|| panic!("history tool_result missing: {captured}"));
    assert_eq!(history["tool_use_id"], "call_history", "{captured}");

    // Client boundary: complete opaque values survive; Anthropic source fields
    // are consumed instead of leaking into the Responses payload.
    let response = client_responses_payload(&client_body);
    assert_eq!(
        response["metadata_center"],
        json!({"business":"kept"}),
        "{response}"
    );
    assert_eq!(
        response["requiredCapabilities"],
        json!(["alpha", "beta"]),
        "{response}"
    );
    assert_eq!(
        response["routecodex_internal"],
        json!({"nested":{"list":[1,2,3]}}),
        "{response}"
    );
    assert_eq!(response["object"], "response", "{response}");
    assert!(
        response.get("content").is_none(),
        "Anthropic content must not leak: {response}"
    );
    assert!(
        response.get("stop_reason").is_none(),
        "Anthropic stop_reason must not leak: {response}"
    );
    assert!(
        response.get("type").is_none(),
        "Anthropic message type must not leak: {response}"
    );
    let output = response["output"]
        .as_array()
        .unwrap_or_else(|| panic!("output array missing: {response}"));
    let call = output
        .iter()
        .find(|item| item["type"] == "function_call")
        .unwrap_or_else(|| panic!("function_call missing: {response}"));
    assert_eq!(call["call_id"], "toolu_opaque", "{response}");
    assert_eq!(call["name"], "lookup", "{response}");
    assert_eq!(call["arguments"], "{\"q\":\"opaque\"}", "{response}");
    assert!(
        response.to_string().contains("opaque business result"),
        "visible provider text must survive: {response}"
    );
    std::env::remove_var(KEY_ENV);
}

/// Native Anthropic Relay must preserve an explicit `tool_result.is_error`
/// boolean exactly. The client's explicit `false`, explicit `true`, and absent
/// marker must each project to the provider-bound Anthropic wire unchanged, and
/// an explicit `false` must never be synthesized for an unmarked success.
#[tokio::test]
async fn anthropic_relay_preserves_explicit_tool_result_is_error_presence() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let provider_body = json!({
        "id":"msg_business_ok","type":"message","role":"assistant",
        "model":"wire-test","content":[{"type":"text","text":"provider finished the turn"}],
        "stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":4}
    })
    .to_string();
    for (label, marker) in [
        ("explicit_false", Some(false)),
        ("explicit_true", Some(true)),
        ("absent", None),
    ] {
        let mut tool_result = json!({
            "type":"tool_result",
            "tool_use_id":"toolu_bash_1",
            "content":"MARKER tool output for is_error preservation"
        });
        if let Some(marker) = marker {
            tool_result["is_error"] = json!(marker);
        }
        let request = json!({
            "model":"test.test","max_tokens":128,"stream":false,
            "tools":[{"name":"Bash","description":"run a shell command","input_schema":{
                "type":"object",
                "properties":{"command":{"type":"string"},"description":{"type":"string"}},
                "required":["command","description"]}}],
            "messages":[
                {"role":"user","content":[{"type":"text","text":"run the check"}]},
                {"role":"assistant","content":[{"type":"tool_use","id":"toolu_bash_1","name":"Bash",
                    "input":{"command":"ls -la","description":"list files"}}]},
                {"role":"user","content":[tool_result]}
            ]
        });
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "anthropic",
            "chat",
            StatusCode::OK,
            "application/json",
            provider_body.clone(),
        )
        .await;
        let (_, client_body) = successful_transfer(
            client()
                .post(endpoint.replace("/v1/responses", "/v1/messages"))
                .json(&request)
                .send()
                .await,
        )
        .await;
        stop_entry(handle, shutdown).await;
        let captured = tokio::time::timeout(Duration::from_secs(2), captures.recv())
            .await
            .expect("real upstream attempt")
            .unwrap();
        assert_eq!(captured["model"], "wire-test");
        assert!(
            matches!(
                captures.try_recv(),
                Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
            ),
            "{label}: exactly one upstream attempt"
        );
        let parts = |message: &Value| -> Vec<Value> {
            message["content"].as_array().cloned().unwrap_or_default()
        };
        let messages = captured["messages"].as_array().expect("provider messages");
        let call = messages
            .iter()
            .flat_map(parts)
            .find(|part| part["type"] == "tool_use")
            .unwrap_or_else(|| panic!("{label}: tool_use missing: {captured}"));
        assert_eq!(call["id"], "toolu_bash_1", "{label}: {captured}");
        assert_eq!(call["name"], "Bash", "{label}: {captured}");
        assert_eq!(call["input"]["command"], "ls -la", "{label}: {captured}");
        assert_eq!(
            call["input"]["description"], "list files",
            "{label}: {captured}"
        );
        let result = messages
            .iter()
            .flat_map(parts)
            .find(|part| part["type"] == "tool_result")
            .unwrap_or_else(|| panic!("{label}: tool_result missing: {captured}"));
        assert_eq!(result["tool_use_id"], "toolu_bash_1", "{label}: {captured}");
        assert!(
            result["content"]
                .to_string()
                .contains("MARKER tool output for is_error preservation"),
            "{label}: tool result content preserved: {captured}"
        );
        match marker {
            Some(expected) => assert_eq!(
                result.get("is_error"),
                Some(&json!(expected)),
                "{label}: explicit is_error must survive the roundtrip: {captured}"
            ),
            None => assert!(
                result.get("is_error").is_none(),
                "{label}: absent marker must remain absent: {captured}"
            ),
        }
        assert!(
            client_body.contains("provider finished the turn"),
            "{label}: client success body must carry provider text: {client_body}"
        );
    }
    std::env::remove_var(KEY_ENV);
}

/// A generic Responses `completed` status is not a native Anthropic marker.
/// It must project to Anthropic without synthesizing `is_error: false`.
#[tokio::test]
async fn responses_completed_tool_output_does_not_synthesize_anthropic_is_error() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let provider_body = json!({
        "id":"msg_business_ok","type":"message","role":"assistant",
        "model":"wire-test","content":[{"type":"text","text":"generic Responses control"}],
        "stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":4}
    })
    .to_string();
    let request = json!({
        "model":"test.test","stream":false,
        "input":[
            {"type":"message","role":"user","content":"run the check"},
            {"type":"function_call","call_id":"call_completed","name":"Bash",
                "arguments":"{\"command\":\"ls -la\",\"description\":\"list files\"}"},
            {"type":"function_call_output","call_id":"call_completed","status":"completed",
                "output":"generic completed output"}
        ]
    });
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "anthropic",
        "chat",
        StatusCode::OK,
        "application/json",
        provider_body,
    )
    .await;
    let (_, client_body) =
        successful_transfer(client().post(&endpoint).json(&request).send().await).await;
    stop_entry(handle, shutdown).await;
    let captured = tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .expect("real upstream attempt")
        .unwrap();
    assert!(
        matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ),
        "exactly one upstream attempt"
    );
    let result = captured["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|part| part["type"] == "tool_result")
        .unwrap_or_else(|| panic!("tool_result missing: {captured}"));
    assert_eq!(result["tool_use_id"], "call_completed", "{captured}");
    assert!(
        result.get("is_error").is_none(),
        "generic Responses completed must not synthesize an Anthropic marker: {captured}"
    );
    assert!(
        client_body.contains("generic Responses control"),
        "client success body must carry provider text: {client_body}"
    );
    std::env::remove_var(KEY_ENV);
}

struct MixedRoundtrip {
    declarations: Vec<Value>,
    response: Value,
    results: Vec<Value>,
}

impl MixedRoundtrip {
    fn bound_calls(&self, request: &Value) -> Option<Vec<Value>> {
        let tools = request["tools"].as_array()?;
        if tools.len() != self.declarations.len() {
            return None;
        }
        let mut names = Vec::new();
        for (actual, expected) in tools.iter().zip(&self.declarations) {
            let name = actual["name"].as_str()?;
            if name.is_empty() || names.contains(&name) {
                return None;
            }
            names.push(name);
            let mut content = actual.clone();
            content.as_object_mut()?.remove("name");
            if content != *expected {
                return None;
            }
        }
        self.response["output"]
            .as_array()?
            .iter()
            .map(|call| {
                let kind = match call["type"].as_str()? {
                    "function_call" => "function",
                    "custom_tool_call" => "custom",
                    _ => return None,
                };
                let index = self
                    .declarations
                    .iter()
                    .position(|tool| tool["type"] == kind)?;
                let mut call = call.clone();
                call["name"] = json!(names[index]);
                call.as_object_mut()?.remove("namespace");
                Some(call)
            })
            .collect()
    }

    fn valid_followup(&self, request: &Value) -> bool {
        let Some(mut expected) = self.bound_calls(request) else {
            return false;
        };
        expected.extend(self.results.clone());
        let Some(input) = request["input"].as_array() else {
            return false;
        };
        let actual: Vec<_> = input
            .iter()
            .filter(|item| {
                matches!(
                    item["type"].as_str(),
                    Some(
                        "function_call"
                            | "custom_tool_call"
                            | "function_call_output"
                            | "custom_tool_call_output"
                    )
                )
            })
            .collect();
        actual.len() == expected.len()
            && actual.iter().zip(&expected).all(|(actual, expected)| {
                actual.get("namespace").is_none()
                    && ["type", "call_id", "name", "arguments", "input", "output"]
                        .iter()
                        .all(|field| actual.get(*field) == expected.get(*field))
            })
    }
}

#[tokio::test]
async fn tool_search_identity_and_opaque_parameters_survive_actual_client_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for kind in ["function", "tool_search", "custom"] {
        let values = if kind == "custom" {
            vec![None, Some(json!({"input":" exact custom input "}))]
        } else {
            vec![
                None,
                Some(json!({"queries":["lookup"]})),
                Some(json!([])),
                Some(Value::Null),
                Some(json!(true)),
                Some(json!(7)),
                Some(json!(1.25)),
                Some(json!(" {broken ")),
                Some(json!("")),
                Some(json!("[1]")),
                Some(json!("{\"queries\":[\"lookup\"]}")),
            ]
        };
        for raw_arguments in values {
            for origin in 0..4 {
                let mut call =
                    json!({"id":"call_search","type":"function","function":{"name":"tool_search"}});
                if let Some(arguments) = &raw_arguments {
                    call["function"]["arguments"] = arguments.clone();
                }
                let initial = json!({"id":"chat-search","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[call]},"finish_reason":"tool_calls"}]});
                let (media, wire) = if origin < 2 {
                    ("application/json", initial.to_string())
                } else if origin == 2 {
                    (
                        "text/event-stream",
                        format!(
                            "data: {}\n\ndata: [DONE]\n\n",
                            json!({"id":"chat-search","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[call]},"finish_reason":"tool_calls"}]})
                        ),
                    )
                } else {
                    (
                        "text/event-stream",
                        format!(
                            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                            json!({"id":"chat-search","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[call]},"finish_reason":null}]}),
                            json!({"id":"chat-search","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
                        ),
                    )
                };
                let tools = if kind == "function" {
                    json!([{"type":"function","name":"tool_search","parameters":{"type":"object","properties":{"queries":{"type":"array","items":{"type":"string"}}}}}])
                } else if kind == "custom" {
                    json!([{"type":"custom","name":"tool_search","format":{"type":"text"}}])
                } else {
                    json!([{"type":"tool_search","execution":"client","parameters":{"type":"object","properties":{"queries":{"type":"array","items":{"type":"string"}}}}}])
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("openai_chat", "chat", StatusCode::OK, media, wire).await;
                let (media, body) = successful_transfer(client().post(endpoint).json(&json!({"model":"test.test","input":"validate tool_search arguments","stream":origin != 0,"tools":tools})).send().await).await;
                let returned = if media.starts_with("application/json") {
                    serde_json::from_str::<Value>(&body).unwrap()["output"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|item| item["call_id"] == "call_search")
                        .unwrap()
                        .clone()
                } else {
                    events(&body)
                        .into_iter()
                        .find_map(|event| {
                            (event["type"] == "response.output_item.done"
                                && event["item"]["call_id"] == "call_search")
                                .then(|| event["item"].clone())
                        })
                        .unwrap()
                };
                assert_eq!(
                    returned["type"],
                    if kind == "tool_search" {
                        "tool_search_call"
                    } else if kind == "custom" {
                        "custom_tool_call"
                    } else {
                        "function_call"
                    },
                    "kind={kind} args={raw_arguments:?} origin={origin}: {returned}"
                );
                let expected_hosted = raw_arguments.as_ref().map(|value| match value {
                    Value::String(text) => serde_json::from_str::<Value>(text)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| value.clone()),
                    _ => value.clone(),
                });
                if kind == "tool_search" {
                    assert_eq!(
                        returned.get("arguments"),
                        expected_hosted.as_ref(),
                        "{returned}"
                    );
                } else if kind == "function" {
                    let text = raw_arguments.as_ref().map(|value| match value {
                        Value::String(text) => text.clone(),
                        value => value.to_string(),
                    });
                    assert_eq!(
                        returned.get("arguments").and_then(Value::as_str),
                        text.as_deref()
                    );
                } else {
                    assert_eq!(
                        returned.get("input"),
                        raw_arguments.as_ref().map(|value| &value["input"])
                    );
                }
                let execution = std::process::Command::new("node").args(["-e", "const c=JSON.parse(process.argv[1]);let p;try{p=c.type==='custom_tool_call'?c.input:c.type==='tool_search_call'?c.arguments:JSON.parse(c.arguments);if(c.type==='custom_tool_call'?typeof p!=='string':!p||typeof p!=='object'||Array.isArray(p)||!Array.isArray(p.queries))throw Error('invalid parameters');process.stdout.write(JSON.stringify({received:p}));}catch(e){process.stdout.write(JSON.stringify({error:e.message,call_id:c.call_id}));}", &returned.to_string()]).output().unwrap();
                assert!(execution.status.success());
                let output = String::from_utf8(execution.stdout).unwrap();
                assert!(serde_json::from_str::<Value>(&output).unwrap().is_object());
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let result_kind = if kind == "custom" {
                    "custom_tool_call_output"
                } else {
                    "function_call_output"
                };
                for next in ["openai_chat", "responses"] {
                    let completion = if next == "openai_chat" {
                        json!({"id":"chat-search-done","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"search roundtrip complete"},"finish_reason":"stop"}]})
                    } else {
                        text_response("search roundtrip complete")
                    };
                    let (endpoint, handle, mut captures, shutdown) = start_entry(
                        next,
                        "chat",
                        StatusCode::OK,
                        "application/json",
                        completion.to_string(),
                    )
                    .await;
                    let (_, body) = successful_transfer(client().post(endpoint).json(&json!({"model":"test.test","tools":tools,"stream":origin != 0,"input":[{"role":"user","content":"validate tool_search arguments"},returned,{"type":result_kind,"call_id":"call_search","output":output}]})).send().await).await;
                    assert!(!body.is_empty());
                    stop_entry(handle, shutdown).await;
                    let wire = captures.recv().await.unwrap();
                    if next == "responses" {
                        let items = wire["input"].as_array().unwrap();
                        let sent = items
                            .iter()
                            .find(|item| {
                                item["call_id"] == "call_search" && item["type"] == returned["type"]
                            })
                            .unwrap_or_else(|| panic!("{wire}"));
                        for field in ["name", "arguments", "input"] {
                            assert_eq!(
                                sent.get(field),
                                returned.get(field),
                                "kind={kind} args={raw_arguments:?}: {wire}"
                            );
                        }
                        let result = items
                            .iter()
                            .find(|item| {
                                item["type"] == result_kind && item["call_id"] == "call_search"
                            })
                            .unwrap();
                        assert_eq!(result["output"], output);
                    } else {
                        let messages = wire["messages"].as_array().unwrap();
                        let sent = messages
                            .iter()
                            .find_map(|message| message["tool_calls"].as_array())
                            .unwrap()
                            .first()
                            .unwrap();
                        assert_eq!(sent["id"], "call_search");
                        assert_eq!(sent["function"]["name"], "tool_search");
                        let expected = if kind == "custom" {
                            raw_arguments.clone()
                        } else {
                            raw_arguments.as_ref().map(|value| match value {
                                Value::String(text) if kind == "tool_search" => {
                                    serde_json::from_str::<Value>(text)
                                        .ok()
                                        .filter(Value::is_object)
                                        .unwrap_or_else(|| value.clone())
                                }
                                _ => value.clone(),
                            })
                        };
                        match expected {
                            None => assert!(sent["function"].get("arguments").is_none(), "{wire}"),
                            Some(Value::String(text)) => {
                                assert_eq!(sent["function"]["arguments"], text, "{wire}")
                            }
                            Some(value) => assert_eq!(
                                serde_json::from_str::<Value>(
                                    sent["function"]["arguments"].as_str().unwrap()
                                )
                                .unwrap(),
                                value,
                                "{wire}"
                            ),
                        };
                        let result = messages
                            .iter()
                            .find(|message| message["role"] == "tool")
                            .unwrap();
                        assert_eq!(result["tool_call_id"], "call_search");
                        assert_eq!(result["content"], output);
                    }
                    assert!(matches!(
                        captures.try_recv(),
                        Err(mpsc::error::TryRecvError::Empty
                            | mpsc::error::TryRecvError::Disconnected)
                    ));
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_reused_id_retains_each_actual_call_and_matching_result_kind() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for stream in [false, true] {
        let mut history = vec![json!({"role":"user","content":"execute both calls"})];
        let mut expected = Vec::new();
        for custom in [false, true] {
            let original = if custom {
                json!({"type":"custom_tool_call","id":"ctc_reused","call_id":"call_reused","name":"lookup","input":{"retain":[1,2]}})
            } else {
                json!({"type":"function_call","id":"fc_reused","call_id":"call_reused","name":"lookup","arguments":"{\"value\":3}"})
            };
            let mut response = text_response("call");
            response["output"] = json!([original]);
            let upstream = if stream {
                response_sse(&response)
            } else {
                response.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                "chat",
                StatusCode::OK,
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                upstream,
            )
            .await;
            let (_, body) = successful_transfer(
                client()
                    .post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
                    .json(&json!({"model":"test.test","stream":stream,"messages":[history[0]]}))
                    .send()
                    .await,
            )
            .await;
            let call = if stream {
                events(&body)
                    .into_iter()
                    .find_map(|event| {
                        event["choices"][0]["delta"]["tool_calls"]
                            .as_array()
                            .and_then(|calls| calls.first())
                            .cloned()
                    })
                    .unwrap()
            } else {
                serde_json::from_str::<Value>(&body).unwrap()["choices"][0]["message"]["tool_calls"]
                    [0]
                .clone()
            };
            assert_eq!(call["id"], "call_reused");
            assert_eq!(call["function"]["name"], "lookup");
            let arguments = call["function"]["arguments"].as_str().unwrap();
            let execution = std::process::Command::new("node")
                .args([
                    "-e",
                    "process.stdout.write(JSON.stringify({received:JSON.parse(process.argv[1])}));",
                    arguments,
                ])
                .output()
                .unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"received":if custom { json!({"input":{"retain":[1,2]}}) } else { json!({"value":3}) }})
            );
            history.push(json!({"role":"assistant","tool_calls":[call]}));
            history.push(json!({"role":"tool","tool_call_id":"call_reused","content":output}));
            expected.push((original, output));
            stop_entry(handle, shutdown).await;
            let _wire = captures.recv().await.unwrap();
            assert!(matches!(
                captures.try_recv(),
                Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
            ));
        }
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            "application/json",
            text_response("reused complete").to_string(),
        )
        .await;
        let (_, body) = successful_transfer(
            client()
                .post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
                .json(&json!({"model":"test.test","stream":stream,"messages":history}))
                .send()
                .await,
        )
        .await;
        assert!(!body.is_empty());
        stop_entry(handle, shutdown).await;
        let wire = captures.recv().await.unwrap();
        let calls: Vec<_> = wire["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                )
            })
            .collect();
        let results: Vec<_> = wire["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call_output" | "custom_tool_call_output")
                )
            })
            .collect();
        assert_eq!(calls.len(), 2, "{wire}");
        assert_eq!(results.len(), 2, "{wire}");
        for (index, (original, output)) in expected.iter().enumerate() {
            assert_eq!(calls[index]["type"], original["type"], "{wire}");
            assert_eq!(calls[index]["call_id"], "call_reused");
            assert_eq!(calls[index]["name"], "lookup");
            if index == 0 {
                assert_eq!(calls[index]["arguments"], original["arguments"]);
            } else {
                assert_eq!(calls[index]["input"], original["input"]);
            }
            assert_eq!(
                results[index]["type"],
                if index == 0 {
                    "function_call_output"
                } else {
                    "custom_tool_call_output"
                },
                "{wire}"
            );
            assert_eq!(results[index]["call_id"], "call_reused");
            assert_eq!(results[index]["output"], *output);
        }
        assert!(matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ));
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn custom_chat_history_preserves_plain_matching_tool_result() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "responses",
        "chat",
        StatusCode::OK,
        "application/json",
        text_response("custom history complete").to_string(),
    )
    .await;
    let call = json!({"id":"call_original","type":"function","function":{"name":"lookup","arguments":"{\"input\":{\"retain\":[1,2]}}"},"routecodex_chat_extension":{"responses_tool_call_type":"custom_tool_call","responses_item_id":"ctc_original"}});
    let request = json!({"model":"test.test","stream":false,"messages":[{"role":"user","content":"custom history"},{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":"call_original","content":"actual custom result"}]});
    let (_, body) = successful_transfer(
        client()
            .post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
            .json(&request)
            .send()
            .await,
    )
    .await;
    assert!(body.contains("mixed roundtrip complete"), "{body}");
    stop_entry(handle, shutdown).await;
    let wire = captures.recv().await.unwrap();
    let items = wire["input"].as_array().unwrap();
    assert!(
        items
            .iter()
            .any(|item| item["type"] == "custom_tool_call"
                && item["input"] == json!({"retain":[1,2]})),
        "{wire}"
    );
    assert!(
        items
            .iter()
            .any(|item| item["type"] == "custom_tool_call_output"
                && item["call_id"] == "call_original"
                && item["output"] == "actual custom result"),
        "{wire}"
    );
    assert!(matches!(
        captures.try_recv(),
        Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
    ));
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_provider_custom_wrappers_decode_values_and_preserve_actual_next_turn() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let values = [
        Some(json!({"retain":[1,2],"input":{"nested":true}})),
        Some(json!([1, "two"])),
        Some(Value::Null),
        Some(json!(true)),
        Some(json!(7)),
        Some(json!(1.25)),
        Some(json!(" raw input \n")),
        Some(json!("")),
        Some(json!({"input":"inner"})),
        None,
    ];
    for input in values {
        for structured_wire in [false, true] {
            for mode in 0..4 {
                let mut initial = json!({"id":"chat-custom","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{"id":"call_original","type":"function","function":{"name":"lookup"}}]},"finish_reason":"tool_calls"}]});
                if let Some(input) = &input {
                    let wrapper = json!({"input":input});
                    initial["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] =
                        if structured_wire {
                            wrapper
                        } else {
                            json!(wrapper.to_string())
                        };
                }
                let (media, upstream) = if mode < 2 {
                    ("application/json", initial.to_string())
                } else {
                    let mut call = initial["choices"][0]["message"]["tool_calls"][0].clone();
                    call["index"] = json!(0);
                    let body = format!(
                        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        json!({"id":"chat-custom","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[call]},"finish_reason":null}]}),
                        json!({"id":"chat-custom","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
                    );
                    ("text/event-stream", body)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
                let tools = json!([{"type":"custom","name":"lookup","format":{"type":"text"}}]);
                let (media, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","input":"execute custom","tools":tools,"stream":mode != 0})).send().await).await;
                let call = if media.starts_with("application/json") {
                    let value: Value = serde_json::from_str(&body).unwrap();
                    value["output"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|item| item["type"] == "custom_tool_call")
                        .unwrap()
                        .clone()
                } else {
                    events(&body)
                        .into_iter()
                        .find_map(|event| {
                            event
                                .get("item")
                                .filter(|item| item["type"] == "custom_tool_call")
                                .cloned()
                                .or_else(|| {
                                    event["response"]["output"]
                                        .as_array()
                                        .and_then(|items| {
                                            items
                                                .iter()
                                                .find(|item| item["type"] == "custom_tool_call")
                                        })
                                        .cloned()
                                })
                        })
                        .unwrap_or_else(|| panic!("missing custom call: {body}"))
                };
                assert_eq!(call["call_id"], "call_original");
                assert_eq!(call["name"], "lookup");
                assert_eq!(
                    call.get("input"),
                    input.as_ref(),
                    "structured_wire={structured_wire} mode={mode}: {body}"
                );
                assert_one_attempt(&mut captures, "wire-test").await;
                let execution = std::process::Command::new("node").args(["-e","const c=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(Object.hasOwn(c,'input')?{received:c.input}:{error:'missing custom input'}));",&call.to_string()]).output().unwrap();
                assert!(execution.status.success());
                let output = String::from_utf8(execution.stdout).unwrap();
                let expected = input
                    .as_ref()
                    .map(|value| json!({"received":value}))
                    .unwrap_or_else(|| json!({"error":"missing custom input"}));
                assert_eq!(serde_json::from_str::<Value>(&output).unwrap(), expected);
                let (_, completed) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","tools":tools,"stream":mode != 0,"input":[{"role":"user","content":"execute custom"},call,{"type":"custom_tool_call_output","call_id":"call_original","output":output}]})).send().await).await;
                assert!(completed.contains("roundtrip complete"), "{completed}");
                stop_entry(handle, shutdown).await;
                let wire = captures.recv().await.unwrap();
                let messages = wire["messages"].as_array().unwrap();
                let sent = messages
                    .iter()
                    .find_map(|message| message["tool_calls"].as_array())
                    .unwrap()
                    .first()
                    .unwrap();
                assert_eq!(sent["id"], "call_original");
                match input.as_ref() {
                    Some(input) => assert_eq!(
                        serde_json::from_str::<Value>(
                            sent["function"]["arguments"].as_str().unwrap()
                        )
                        .unwrap(),
                        json!({"input":input})
                    ),
                    None => assert!(sent["function"].get("arguments").is_none()),
                }
                let result = messages
                    .iter()
                    .find(|message| message["role"] == "tool")
                    .unwrap();
                assert_eq!(result["tool_call_id"], "call_original");
                assert_eq!(result["content"], output);
                assert!(matches!(
                    captures.try_recv(),
                    Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
                ));
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn custom_chat_calls_retain_kind_input_and_actual_execution_result_on_next_provider() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for input in [
        json!({"retain":[1,2],"input":{"nested":true}}),
        json!([1, "two"]),
        Value::Null,
        json!(true),
        json!(7),
        json!(1.25),
        json!(" raw custom input \n"),
        json!(""),
        json!({"input":"inner"}),
    ] {
        for origin in 0..5 {
            let original = json!({"type":"custom_tool_call","id":"ctc_original","call_id":"call_original","name":"lookup","input":input});
            let mut initial = text_response("custom input");
            initial["output"] = json!([original]);
            let (media, upstream) = if origin < 2 {
                ("application/json", initial.to_string())
            } else if origin == 2 {
                ("text/event-stream", response_sse(&initial))
            } else if origin == 3 {
                (
                    "text/event-stream",
                    format!(
                        "{}{}",
                        sse(
                            "response.output_item.done",
                            &json!({"type":"response.output_item.done","output_index":0,"item":original})
                        ),
                        response_sse(&initial)
                    ),
                )
            } else {
                let mut added = original.clone();
                added.as_object_mut().unwrap().remove("input");
                let mut terminal = initial.clone();
                terminal.as_object_mut().unwrap().remove("output");
                (
                    "text/event-stream",
                    format!(
                        "{}{}{}",
                        sse(
                            "response.output_item.added",
                            &json!({"type":"response.output_item.added","output_index":0,"item":added})
                        ),
                        sse(
                            "response.custom_tool_call_input.done",
                            &json!({"type":"response.custom_tool_call_input.done","item_id":"ctc_original","output_index":0,"input":input})
                        ),
                        response_sse(&terminal)
                    ),
                )
            };
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("responses", "chat", StatusCode::OK, media, upstream).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
            let (media, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","messages":[{"role":"user","content":"execute custom"}],"stream":origin != 0})).send().await).await;
            let call = if media.starts_with("application/json") {
                serde_json::from_str::<Value>(&body).unwrap()["choices"][0]["message"]["tool_calls"]
                    [0]
                .clone()
            } else {
                events(&body)
                    .into_iter()
                    .find_map(|event| {
                        event["choices"][0]["delta"]["tool_calls"]
                            .as_array()
                            .and_then(|calls| calls.first())
                            .cloned()
                    })
                    .unwrap_or_else(|| panic!("input={input} origin={origin}: {body}"))
            };
            assert_eq!(call["id"], "call_original");
            assert_eq!(call["function"]["name"], "lookup");
            assert_eq!(
                call["routecodex_chat_extension"]["responses_tool_call_type"], "custom_tool_call",
                "input={input} origin={origin}: {body}"
            );
            let arguments = call["function"]["arguments"].as_str().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(arguments).unwrap(),
                json!({"input":input})
            );
            let execution = std::process::Command::new("node").args(["-e","const a=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({received:a.input}));",arguments]).output().unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"received":input})
            );
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            for (next_kind, process) in [
                ("responses", "responses"),
                ("responses", "chat"),
                ("openai_chat", "chat"),
                ("anthropic", "chat"),
            ] {
                for stream in [false, true] {
                    let completion = if next_kind == "openai_chat" {
                        json!({"id":"chat-followup","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"custom roundtrip complete"},"finish_reason":"stop"}]})
                    } else if next_kind == "anthropic" {
                        json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"custom roundtrip complete"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}})
                    } else {
                        text_response("custom roundtrip complete")
                    };
                    let (endpoint, handle, mut captures, shutdown) = start_entry(
                        next_kind,
                        process,
                        StatusCode::OK,
                        "application/json",
                        completion.to_string(),
                    )
                    .await;
                    let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
                    let (_, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","stream":stream,"messages":[{"role":"user","content":"execute custom"},{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":"call_original","content":output}]})).send().await).await;
                    assert!(!body.is_empty());
                    stop_entry(handle, shutdown).await;
                    let wire = captures.recv().await.unwrap();
                    if next_kind == "responses" {
                        let items = wire["input"].as_array().unwrap();
                        let sent = items
                            .iter()
                            .find(|item| item["type"] == "custom_tool_call")
                            .expect("original custom type");
                        assert_eq!(sent["call_id"], "call_original");
                        assert_eq!(sent["name"], "lookup");
                        assert_eq!(sent["input"], input, "{wire}");
                        let result = items
                            .iter()
                            .find(|item| item["type"] == "custom_tool_call_output")
                            .expect("matching custom result");
                        assert_eq!(result["call_id"], "call_original");
                        assert_eq!(result["output"], output);
                    } else if next_kind == "openai_chat" {
                        let messages = wire["messages"].as_array().unwrap();
                        let sent = messages
                            .iter()
                            .find_map(|message| message["tool_calls"].as_array())
                            .unwrap()
                            .first()
                            .unwrap();
                        assert_eq!(sent["id"], "call_original");
                        assert_eq!(
                            serde_json::from_str::<Value>(
                                sent["function"]["arguments"].as_str().unwrap()
                            )
                            .unwrap(),
                            json!({"input":input})
                        );
                        let result = messages
                            .iter()
                            .find(|message| message["role"] == "tool")
                            .unwrap();
                        assert_eq!(result["tool_call_id"], "call_original");
                        assert_eq!(result["content"], output);
                    } else {
                        let blocks: Vec<_> = wire["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .flat_map(|message| message["content"].as_array().unwrap())
                            .collect();
                        let sent = blocks
                            .iter()
                            .find(|block| block["type"] == "tool_use")
                            .unwrap();
                        assert_eq!(sent["id"], "call_original");
                        assert_eq!(sent["input"], json!({"input":input}));
                        let result = blocks
                            .iter()
                            .find(|block| block["type"] == "tool_result")
                            .unwrap();
                        assert_eq!(result["tool_use_id"], "call_original");
                        assert_eq!(result["content"], output);
                    }
                    assert!(matches!(
                        captures.try_recv(),
                        Err(mpsc::error::TryRecvError::Empty
                            | mpsc::error::TryRecvError::Disconnected)
                    ));
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn missing_tool_parameters_and_client_validation_results_survive_correction_turn() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for kind in ["function_call", "custom_tool_call"] {
        let field = if kind == "function_call" {
            "arguments"
        } else {
            "input"
        };
        let output_kind = if kind == "function_call" {
            "function_call_output"
        } else {
            "custom_tool_call_output"
        };
        for origin in 0..5 {
            for original_client in ["responses", "chat"] {
                let original = json!({"type":kind,"id":"fc_original","call_id":"call_original","name":"lookup"});
                let mut initial = text_response("validate original call");
                initial["output"] = json!([original]);
                let (media, upstream) = if origin < 2 {
                    ("application/json", initial.to_string())
                } else if origin == 2 {
                    ("text/event-stream", response_sse(&initial))
                } else if origin == 3 {
                    (
                        "text/event-stream",
                        format!(
                            "{}{}",
                            sse(
                                "response.output_item.done",
                                &json!({"type":"response.output_item.done","output_index":0,"item":original})
                            ),
                            response_sse(&initial)
                        ),
                    )
                } else {
                    let done_name = if kind == "function_call" {
                        "response.function_call_arguments.done"
                    } else {
                        "response.custom_tool_call_input.done"
                    };
                    let mut terminal = initial.clone();
                    terminal.as_object_mut().unwrap().remove("output");
                    (
                        "text/event-stream",
                        format!(
                            "{}{}{}",
                            sse(
                                "response.output_item.added",
                                &json!({"type":"response.output_item.added","output_index":0,"item":original})
                            ),
                            sse(
                                done_name,
                                &json!({"type":done_name,"item_id":"fc_original","output_index":0})
                            ),
                            response_sse(&terminal)
                        ),
                    )
                };
                let (endpoint, handle, mut captures, shutdown) = start_entry(
                    "responses",
                    if original_client == "chat" {
                        "chat"
                    } else {
                        "responses"
                    },
                    StatusCode::OK,
                    media,
                    upstream,
                )
                .await;
                let endpoint = if original_client == "chat" {
                    endpoint.replace("/v1/responses", "/v1/chat/completions")
                } else {
                    endpoint
                };
                let initial_request = if original_client == "chat" {
                    json!({"model":"test.test","messages":[{"role":"user","content":"validate tool call"}],"stream":origin != 0})
                } else {
                    json!({"model":"test.test","input":"validate tool call","stream":origin != 0})
                };
                let (media, body) = successful_transfer(
                    client().post(&endpoint).json(&initial_request).send().await,
                )
                .await;
                let call = if original_client == "chat" {
                    if media.starts_with("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()["choices"][0]["message"]
                            ["tool_calls"][0]
                            .clone()
                    } else {
                        events(&body)
                            .into_iter()
                            .find_map(|e| {
                                e["choices"][0]["delta"]["tool_calls"]
                                    .as_array()
                                    .and_then(|a| a.first())
                                    .cloned()
                            })
                            .unwrap()
                    }
                } else {
                    let returned = if media.starts_with("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        events(&body)
                            .into_iter()
                            .filter_map(|e| e.get("response").cloned())
                            .last()
                            .unwrap()
                    };
                    if let Some(output) = returned.get("output") {
                        output
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|item| item["type"] == kind)
                            .unwrap()
                            .clone()
                    } else {
                        events(&body)
                            .into_iter()
                            .rev()
                            .filter_map(|event| event.get("item").cloned())
                            .find(|item| item["type"] == kind)
                            .expect(
                                "client accumulates an original item when terminal omits output",
                            )
                    }
                };
                let call_id = if original_client == "chat" {
                    &call["id"]
                } else {
                    &call["call_id"]
                };
                let name = if original_client == "chat" {
                    &call["function"]["name"]
                } else {
                    &call["name"]
                };
                let parameters = if original_client == "chat" {
                    &call["function"]
                } else {
                    &call
                };
                let parameter_field = if original_client == "chat" {
                    "arguments"
                } else {
                    field
                };
                let projected_kind = kind;
                let projected_output_kind = output_kind;
                assert_eq!(*call_id, original["call_id"]);
                assert_eq!(*name, original["name"]);
                assert!(
                    parameters.get(parameter_field).is_none(),
                    "missing parameter must reach the client unchanged: {body}"
                );
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let validation = std::process::Command::new("node").args(["-e", "const c=JSON.parse(process.argv[1]); const f=process.argv[2]; if(Object.hasOwn(c,f))process.exit(1); process.stdout.write('client validation error: missing '+f);", &parameters.to_string(), parameter_field]).output().unwrap();
                assert!(validation.status.success());
                let validation = String::from_utf8(validation.stdout).unwrap();
                for (next_kind, process) in [
                    ("responses", "responses"),
                    ("responses", "chat"),
                    ("openai_chat", "chat"),
                    ("anthropic", "chat"),
                ] {
                    for stream in [false, true] {
                        let completion = if next_kind == "anthropic" {
                            json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"correction received"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":3}})
                        } else if next_kind == "openai_chat" {
                            json!({"id":"chat-followup","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"correction received"},"finish_reason":"stop"}]})
                        } else {
                            text_response("correction received")
                        };
                        let (endpoint, handle, mut captures, shutdown) = start_entry(
                            next_kind,
                            process,
                            StatusCode::OK,
                            "application/json",
                            completion.to_string(),
                        )
                        .await;
                        let endpoint = if original_client == "chat" {
                            endpoint.replace("/v1/responses", "/v1/chat/completions")
                        } else {
                            endpoint
                        };
                        let correction = if original_client == "chat" {
                            json!({"model":"test.test","stream":stream,"messages":[{"role":"user","content":"validate tool call"},{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":call_id,"content":validation}]})
                        } else {
                            json!({"model":"test.test","stream":stream,"input":[{"role":"user","content":"validate tool call"},call,{"type":output_kind,"call_id":call_id,"output":validation}]})
                        };
                        eprintln!("R12 correction kind={kind} client={original_client} origin={origin} next={next_kind} process={process} stream={stream}");
                        let response = client().post(&endpoint).json(&correction).send().await;
                        let (_, completed) = successful_transfer(response).await;
                        stop_entry(handle, shutdown).await;
                        let wire = captures
                            .recv()
                            .await
                            .expect("original call and client error reach next provider");
                        if next_kind == "responses" {
                            let items = wire["input"].as_array().unwrap();
                            let sent = items
                                .iter()
                                .find(|item| item["type"] == projected_kind)
                                .unwrap();
                            assert_eq!(sent["call_id"], *call_id);
                            assert_eq!(sent["name"], *name);
                            assert!(sent.get(field).is_none(), "invented parameter: {wire}");
                            let result = items
                                .iter()
                                .find(|item| item["type"] == projected_output_kind)
                                .unwrap();
                            assert_eq!(result["call_id"], *call_id);
                            assert_eq!(result["output"], validation);
                        } else if next_kind == "openai_chat" {
                            let messages = wire["messages"].as_array().unwrap();
                            let sent = messages
                                .iter()
                                .find_map(|m| m["tool_calls"].as_array())
                                .unwrap();
                            assert_eq!(sent[0]["id"], *call_id);
                            assert_eq!(sent[0]["function"]["name"], *name);
                            assert!(
                                sent[0]["function"].get("arguments").is_none(),
                                "invented parameter: {wire}"
                            );
                            let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
                            assert_eq!(result["tool_call_id"], *call_id);
                            assert_eq!(result["content"], validation);
                        } else {
                            let blocks: Vec<&Value> = wire["messages"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .flat_map(|m| m["content"].as_array().unwrap())
                                .collect();
                            let sent = blocks.iter().find(|b| b["type"] == "tool_use").unwrap();
                            assert_eq!(sent["id"], *call_id);
                            assert_eq!(sent["name"], *name);
                            assert!(sent.get("input").is_none(), "invented parameter: {wire}");
                            let result =
                                blocks.iter().find(|b| b["type"] == "tool_result").unwrap();
                            assert_eq!(result["tool_use_id"], *call_id);
                            assert_eq!(result["content"], validation);
                        }
                        assert!(!completed.is_empty());
                        assert!(matches!(
                            captures.try_recv(),
                            Err(mpsc::error::TryRecvError::Empty
                                | mpsc::error::TryRecvError::Disconnected)
                        ));
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn tool_parameter_values_and_matching_results_survive_request_projection() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let domain = [
        None,
        Some(json!({"retain":[1,2]})),
        Some(json!("{\"retain\":[1,2]}")),
        Some(json!("{\"q\":")),
        Some(json!("")),
        Some(json!([1,{"keep":true}])),
        Some(Value::Null),
        Some(json!(true)),
        Some(json!(7)),
    ];
    for raw in domain {
        for kind in ["function_call", "custom_tool_call"] {
            let field = if kind == "function_call" {
                "arguments"
            } else {
                "input"
            };
            let output_kind = if kind == "function_call" {
                "function_call_output"
            } else {
                "custom_tool_call_output"
            };
            let mut call =
                json!({"type":kind,"id":"fc_original","call_id":"call_original","name":"lookup"});
            if let Some(raw) = &raw {
                call[field] = raw.clone();
            }
            for (next_kind, process) in [
                ("responses", "responses"),
                ("responses", "chat"),
                ("openai_chat", "chat"),
                ("anthropic", "chat"),
            ] {
                for stream in [false, true] {
                    let completion = if next_kind == "anthropic" {
                        json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"correction received"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":3}})
                    } else {
                        text_response("correction received")
                    };
                    let (endpoint, handle, mut captures, shutdown) = start_entry(
                        next_kind,
                        process,
                        StatusCode::OK,
                        "application/json",
                        completion.to_string(),
                    )
                    .await;
                    let result_text = "original client validation or execution result";
                    eprintln!("R11 values kind={kind} raw={raw:?} next={next_kind} process={process} stream={stream}");
                    let (_, completed) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","stream":stream,"input":[{"role":"user","content":"retain original history"},call,{"type":output_kind,"call_id":call["call_id"],"output":result_text}]})).send().await).await;
                    stop_entry(handle, shutdown).await;
                    let wire = captures
                        .recv()
                        .await
                        .expect("paired history reaches selected provider");
                    if next_kind == "responses" {
                        let items = wire["input"].as_array().unwrap();
                        let sent = items.iter().find(|item| item["type"] == kind).unwrap();
                        assert_eq!(sent["call_id"], call["call_id"]);
                        assert_eq!(sent["name"], call["name"]);
                        match &raw {
                            None => assert!(sent.get(field).is_none(), "{wire}"),
                            Some(raw)
                                if kind == "function_call"
                                    && !raw.is_string()
                                    && sent[field].is_string() =>
                            {
                                assert_eq!(
                                    serde_json::from_str::<Value>(sent[field].as_str().unwrap())
                                        .unwrap(),
                                    *raw,
                                    "{wire}"
                                )
                            }
                            Some(raw) => assert_eq!(sent[field], *raw, "{wire}"),
                        }
                        let result = items
                            .iter()
                            .find(|item| item["type"] == output_kind)
                            .unwrap();
                        assert_eq!(result["call_id"], call["call_id"]);
                        assert_eq!(result["output"], result_text);
                    } else if next_kind == "openai_chat" {
                        let messages = wire["messages"].as_array().unwrap();
                        let sent = messages
                            .iter()
                            .find_map(|m| m["tool_calls"].as_array())
                            .unwrap();
                        assert_eq!(sent[0]["id"], call["call_id"]);
                        assert_eq!(sent[0]["function"]["name"], call["name"]);
                        match &raw {
                            None => {
                                assert!(sent[0]["function"].get("arguments").is_none(), "{wire}")
                            }
                            Some(raw) if kind == "custom_tool_call" => assert_eq!(
                                serde_json::from_str::<Value>(
                                    sent[0]["function"]["arguments"].as_str().unwrap()
                                )
                                .unwrap(),
                                json!({"input":raw}),
                                "{wire}"
                            ),
                            Some(raw) => assert_eq!(
                                sent[0]["function"]["arguments"],
                                raw.as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| raw.to_string()),
                                "{wire}"
                            ),
                        }
                        let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
                        assert_eq!(result["tool_call_id"], call["call_id"]);
                        assert_eq!(result["content"], result_text);
                    } else {
                        let blocks: Vec<&Value> = wire["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .flat_map(|m| m["content"].as_array().unwrap())
                            .collect();
                        let sent = blocks.iter().find(|b| b["type"] == "tool_use").unwrap();
                        assert_eq!(sent["id"], call["call_id"]);
                        assert_eq!(sent["name"], call["name"]);
                        match &raw {
                            None => assert!(sent.get("input").is_none(), "{wire}"),
                            Some(raw) if kind == "custom_tool_call" => {
                                assert_eq!(sent["input"], json!({"input":raw}), "{wire}")
                            }
                            Some(Value::String(raw)) => assert_eq!(
                                sent["input"],
                                serde_json::from_str::<Value>(raw)
                                    .unwrap_or_else(|_| json!({"input":raw})),
                                "{wire}"
                            ),
                            Some(raw) => assert_eq!(sent["input"], *raw, "{wire}"),
                        }
                        let result = blocks.iter().find(|b| b["type"] == "tool_result").unwrap();
                        assert_eq!(result["tool_use_id"], call["call_id"]);
                        assert_eq!(result["content"], result_text);
                    }
                    assert!(!completed.is_empty());
                    assert!(matches!(
                        captures.try_recv(),
                        Err(mpsc::error::TryRecvError::Empty
                            | mpsc::error::TryRecvError::Disconnected)
                    ));
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

async fn probe_native_followup_attempt(
    next_kind: &str,
    thinking: &str,
    call_id: &str,
    input: &Value,
    signature: Option<&str>,
) -> Value {
    let reply = if next_kind == "anthropic" {
        json!({"id":"msg_followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"CLAUDE_NATIVE_TOOL_PROBE"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}})
    } else {
        json!({"id":"chat_followup","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"CLAUDE_NATIVE_TOOL_PROBE"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})
    };
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        next_kind,
        "chat",
        StatusCode::OK,
        "application/json",
        reply.to_string(),
    )
    .await;
    let mut thinking_block = json!({"type":"thinking","thinking":thinking});
    if let Some(signature) = signature {
        thinking_block["signature"] = json!(signature);
    }
    let request = json!({
        "model":"test.test","max_tokens":128,"stream":false,
        "tools":[{"name":"Bash","description":"Execute command","input_schema":{"type":"object","properties":{"command":{"type":"string"},"description":{"type":"string"}}}}],
        "messages":[
            {"role":"user","content":"Run the probe once and report its result."},
            {"role":"assistant","content":[thinking_block,{"type":"tool_use","id":call_id,"name":"Bash","input":input}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":call_id,"content":"CLAUDE_NATIVE_TOOL_PROBE","is_error":false}]}
        ]
    });
    let result = client()
        .post(endpoint.replace("/v1/responses", "/v1/messages"))
        .json(&request)
        .send()
        .await;
    let wire = tokio::time::timeout(Duration::from_secs(3), captures.recv()).await;
    stop_entry(handle, shutdown).await;
    let wire = wire
        .unwrap_or_else(|_| {
            panic!(
                "signature={signature:?} next_kind={next_kind}: followup must reach its first provider attempt"
            )
        })
        .expect("provider capture");
    assert!(
        captures.try_recv().is_err(),
        "signature={signature:?} next_kind={next_kind}: followup must use exactly one provider attempt"
    );
    assert!(
        result
            .expect("successful native followup transport")
            .status()
            .is_success(),
        "signature={signature:?} next_kind={next_kind}"
    );
    wire
}

fn assert_native_followup_thinking_and_tool_history(
    next_kind: &str,
    wire: &Value,
    thinking: &str,
    call_id: &str,
    input: &Value,
) {
    if next_kind == "openai_chat" {
        let messages = wire["messages"].as_array().expect("Chat history");
        let assistant = messages
            .iter()
            .find(|m| m["tool_calls"].is_array())
            .expect("paired assistant call");
        assert_eq!(assistant["reasoning_content"], thinking);
        assert_eq!(assistant["tool_calls"][0]["id"], call_id);
        assert_eq!(
            serde_json::from_str::<Value>(
                assistant["tool_calls"][0]["function"]["arguments"]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            *input
        );
        assert!(messages.iter().any(|m| {
            m["role"] == "tool"
                && m["tool_call_id"] == call_id
                && m["content"] == "CLAUDE_NATIVE_TOOL_PROBE"
        }));
    } else {
        let messages = wire["messages"].as_array().expect("Anthropic history");
        let blocks: Vec<&Value> = messages
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .collect();
        let thinking_block = blocks
            .iter()
            .find(|b| b["type"] == "thinking")
            .expect("native thinking block");
        assert_eq!(thinking_block["thinking"], thinking);
        let tool = blocks
            .iter()
            .find(|b| b["type"] == "tool_use")
            .expect("native tool use");
        assert_eq!(tool["id"], call_id);
        assert_eq!(tool["name"], "Bash");
        assert_eq!(tool["input"], *input, "{wire}");
        let result = blocks
            .iter()
            .find(|b| b["type"] == "tool_result")
            .expect("native tool result");
        assert_eq!(result["tool_use_id"], call_id);
        assert_eq!(result["content"], "CLAUDE_NATIVE_TOOL_PROBE");
    }
}

#[tokio::test]
async fn anthropic_empty_signature_tool_followup_reaches_first_provider_attempt() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let thinking = "We need obey exact once Bash with command. Need commentary tool call. Then report actual output.";
    let call_id = "call_00_0DgLrsue3mL4JgHTP5rM6075";
    let input = json!({"command":"/usr/bin/printf CLAUDE_NATIVE_TOOL_PROBE","description":"Print tool probe marker"});
    for signature in [None, Some(""), Some("sig_nonempty")] {
        for next_kind in ["openai_chat", "anthropic"] {
            let wire =
                probe_native_followup_attempt(next_kind, thinking, call_id, &input, signature)
                    .await;
            assert_native_followup_thinking_and_tool_history(
                next_kind, &wire, thinking, call_id, &input,
            );
            if next_kind == "anthropic" {
                let messages = wire["messages"].as_array().expect("Anthropic history");
                let thinking_block = messages
                    .iter()
                    .filter_map(|m| m["content"].as_array())
                    .flatten()
                    .find(|b| b["type"] == "thinking")
                    .expect("native thinking block");
                match signature {
                    None => assert!(thinking_block.get("signature").is_none(), "{wire}"),
                    Some(signature) => {
                        assert_eq!(thinking_block["signature"], signature, "{wire}")
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

// Independent defect bfd9e2c: the native `tool_result.is_error: false` is an
// explicit business field and must survive the round trip. This case stays RED
// until that defect's owner fixes it; the signature scope above is separate.
#[tokio::test]
async fn anthropic_tool_result_explicit_false_preserved_on_tool_followup() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let thinking = "We need obey exact once Bash with command. Need commentary tool call. Then report actual output.";
    let call_id = "call_00_0DgLrsue3mL4JgHTP5rM6075";
    let input = json!({"command":"/usr/bin/printf CLAUDE_NATIVE_TOOL_PROBE","description":"Print tool probe marker"});
    for signature in [None, Some(""), Some("sig_nonempty")] {
        let wire =
            probe_native_followup_attempt("anthropic", thinking, call_id, &input, signature).await;
        let messages = wire["messages"].as_array().expect("Anthropic history");
        let blocks: Vec<&Value> = messages
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .collect();
        let result = blocks
            .iter()
            .find(|b| b["type"] == "tool_result")
            .expect("native tool result");
        assert_eq!(result["tool_use_id"], call_id);
        assert_eq!(result["content"], "CLAUDE_NATIVE_TOOL_PROBE");
        assert_eq!(result["is_error"], false, "{wire}");
    }
    std::env::remove_var(KEY_ENV);
}

async fn controlled_upstream(
    State(state): State<Arc<ProviderState>>,
    request: axum::extract::Request,
) -> Response<Body> {
    if let Some(live_forward) = &state.live_forward {
        let (parts, body) = request.into_parts();
        let request_body = match to_bytes(body, usize::MAX).await {
            Ok(body) => body.to_vec(),
            Err(error) => {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Body::from(format!("request body unavailable: {error}")))
                    .unwrap();
            }
        };
        let request_content_type = parts.headers.get(CONTENT_TYPE).cloned();
        let completed = live_forward.captures.lock().unwrap().len();
        let has_tool_result = serde_json::from_slice::<Value>(&request_body)
            .ok()
            .and_then(|body| body["messages"].as_array().cloned())
            .is_some_and(|messages| messages.iter().any(|message| message["role"] == "tool"));
        if completed >= 2 || (completed == 1 && !has_tool_result) {
            eprintln!("LIVE_PROBE_STOP: retry or extra generation outside the two-turn case");
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from("live probe stopped; original exchange retained"))
                .unwrap();
        }
        let mut request = live_forward
            .client
            .post(&live_forward.target)
            .body(request_body.clone());
        if let Some(content_type) = request_content_type {
            request = request.header(CONTENT_TYPE, content_type);
        }
        let mut exchange = LiveForwardExchange {
            request_body,
            ..LiveForwardExchange::default()
        };
        let response = match request.send().await {
            Ok(response) => {
                let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
                let content_type = response
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                match response.bytes().await {
                    Ok(body) => {
                        exchange.response_status = Some(status);
                        exchange.response_content_type = content_type.clone();
                        exchange.response_body = body.to_vec();
                        Some((status, content_type, body))
                    }
                    Err(error) => {
                        exchange.response_status = Some(status);
                        exchange.response_content_type = content_type;
                        exchange.transport_error = Some(error.to_string());
                        None
                    }
                }
            }
            Err(error) => {
                exchange.transport_error = Some(error.to_string());
                None
            }
        };
        let mut captured = live_forward.captures.lock().unwrap();
        let number = captured.len() + 1;
        let evidence_dir = live_native_evidence_dir();
        write_live_evidence(
            &evidence_dir,
            &format!("claude-live-native-candidate-wire-{number}.json"),
            &exchange.request_body,
        );
        write_live_evidence(
            &evidence_dir,
            &format!("claude-live-native-rcc-response-{number}.body"),
            &exchange.response_body,
        );
        write_live_evidence(&evidence_dir, &format!("claude-live-native-exchange-{number}.meta.json"),
            json!({"rcc_status":exchange.response_status.map(|status|status.as_u16()),
                "rcc_content_type":exchange.response_content_type,"transport_error":exchange.transport_error}).to_string().as_bytes());
        captured.push(exchange);
        drop(captured);
        return match response {
            Some((status, content_type, body)) => {
                let mut builder = Response::builder().status(status);
                if let Some(content_type) = content_type {
                    builder =
                        builder.header(CONTENT_TYPE, HeaderValue::from_str(&content_type).unwrap());
                }
                builder.body(Body::from(body)).unwrap()
            }
            None => Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("live upstream transport failed"))
                .unwrap(),
        };
    }
    let (parts, request_body) = request.into_parts();
    let body = match to_bytes(request_body, usize::MAX).await {
        Ok(body) => match serde_json::from_slice::<Value>(&body) {
            Ok(body) => body,
            Err(error) => {
                return Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Body::from(format!("invalid JSON body: {error}")))
                    .unwrap();
            }
        },
        Err(error) => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(format!("request body unavailable: {error}")))
                .unwrap();
        }
    };
    state.captures.send(body.clone()).unwrap();
    if let Some(header_captures) = &state.header_captures {
        let auth = parts
            .headers
            .iter()
            .filter(|(name, _)| matches!(name.as_str(), "authorization" | "x-api-key"))
            .map(|(name, value)| {
                format!(
                    "{}: {}",
                    name.as_str(),
                    value.to_str().unwrap_or("<binary>")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        let _ = header_captures.send(auth);
    }
    if !state.attempt_bodies.is_empty() {
        let attempt = state
            .attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let wire = state
            .attempt_bodies
            .get(attempt)
            .cloned()
            .unwrap_or_else(|| state.body.clone());
        let status = state
            .attempt_statuses
            .get(attempt)
            .copied()
            .unwrap_or_else(|| state.status_override.unwrap_or(state.status));
        if state.hold_attempt_open {
            let stream =
                stream::once(async move { Ok::<_, Infallible>(wire) }).chain(stream::pending());
            return Response::builder()
                .status(status)
                .header("content-type", state.content_type)
                .body(Body::from_stream(stream))
                .unwrap();
        }
        return Response::builder()
            .status(status)
            .header("content-type", state.content_type)
            .body(Body::from(wire))
            .unwrap();
    }
    if let Some(mixed) = &state.mixed {
        let mut response = mixed.response.clone();
        if body["input"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item["type"].as_str(),
                    Some(
                        "function_call"
                            | "custom_tool_call"
                            | "function_call_output"
                            | "custom_tool_call_output"
                    )
                )
            })
        }) {
            assert!(
                mixed.valid_followup(&body),
                "invalid complete mixed followup: {body}"
            );
            response = text_response("mixed roundtrip complete");
        } else {
            response["output"] = json!(mixed
                .bound_calls(&body)
                .expect("complete native declarations"));
        }
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", state.content_type)
            .body(Body::from(if state.content_type == "application/json" {
                response.to_string()
            } else {
                response_sse(&response)
            }))
            .unwrap();
    }
    if body.to_string().contains("representation-valid-request")
        || (state.health_enabled && !body.to_string().contains("representation-invalid-"))
    {
        let completed = if state.kind == "openai_chat" {
            json!({"id":"chat-valid","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"representation-valid-completion"},"finish_reason":"stop"}]})
        } else {
            text_response("representation-valid-completion")
        };
        let wire = if state.content_type == "application/json" {
            completed.to_string()
        } else if state.kind == "openai_chat" {
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"id":"chat-valid","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","content":"representation-valid-completion"},"finish_reason":"stop"}]})
            )
        } else {
            response_sse(&completed)
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", state.content_type)
            .body(Body::from(wire))
            .unwrap();
    }
    if body["messages"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|m| m["role"] == "tool"))
    {
        let completion = json!({"id":"chatcmpl-followup","object":"chat.completion","model":"wire-test",
            "choices":[{"index":0,"message":{"role":"assistant","content":"chat roundtrip complete"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}});
        let response = if state.content_type == "application/json" {
            completion.to_string()
        } else {
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"id":"chatcmpl-followup","object":"chat.completion.chunk","model":"wire-test",
                "choices":[{"index":0,"delta":{"role":"assistant","content":"chat roundtrip complete"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
            )
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", state.content_type)
            .body(Body::from(response))
            .unwrap();
    }
    if body
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("function_call_output" | "custom_tool_call_output")
                )
            })
        })
    {
        let completed = text_response("mixed roundtrip complete");
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", state.content_type)
            .body(Body::from(if state.content_type == "application/json" {
                completed.to_string()
            } else {
                response_sse(&completed)
            }))
            .unwrap();
    }
    // Independently pinned candidate: this asserts listener isolation without
    // assuming recovery of the failed provider identity.
    if body["model"] == "wire-independent" {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(response_sse(&text_response("independent ok"))))
            .unwrap();
    }
    Response::builder()
        .status(state.status)
        .header("content-type", state.content_type)
        .body(Body::from(state.body.clone()))
        .unwrap()
}

fn text_response(text: &str) -> Value {
    json!({"id":"resp_control","object":"response","status":"completed","model":"wire-test",
        "output":[{"id":"msg_control","type":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]}]})
}

fn sse(event: &str, value: &Value) -> String {
    format!("event: {event}\ndata: {value}\n\n")
}

fn response_sse(response: &Value) -> String {
    let event = if response["status"] == "incomplete" {
        "response.incomplete"
    } else {
        "response.completed"
    };
    sse(event, &json!({"type":event,"response":response}))
}

fn anthropic_empty_success_sse(message_id: &str) -> String {
    format!(
        "{}{}{}",
        sse(
            "message_start",
            &json!({"type":"message_start","message":{"id":message_id,"type":"message",
                "role":"assistant","model":"wire-test","content":[],
                "stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}})
        ),
        sse(
            "message_delta",
            &json!({"type":"message_delta",
                "delta":{"stop_reason":"end_turn","stop_sequence":null},
                "usage":{"output_tokens":0}})
        ),
        sse("message_stop", &json!({"type":"message_stop"}))
    )
}

fn anthropic_text_sse(message_id: &str, text: &str) -> String {
    format!(
        "{}{}{}{}{}{}",
        sse(
            "message_start",
            &json!({"type":"message_start","message":{"id":message_id,"type":"message",
                "role":"assistant","model":"wire-test","content":[],
                "stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}})
        ),
        sse(
            "content_block_start",
            &json!({"type":"content_block_start","index":0,
                "content_block":{"type":"text","text":""}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":text}})
        ),
        sse(
            "content_block_stop",
            &json!({"type":"content_block_stop","index":0})
        ),
        sse(
            "message_delta",
            &json!({"type":"message_delta",
                "delta":{"stop_reason":"end_turn","stop_sequence":null},
                "usage":{"output_tokens":1}})
        ),
        sse("message_stop", &json!({"type":"message_stop"}))
    )
}

fn anthropic_tool_only_sse(message_id: &str) -> String {
    format!(
        "{}{}{}{}{}{}",
        sse(
            "message_start",
            &json!({"type":"message_start","message":{"id":message_id,"type":"message",
                "role":"assistant","model":"wire-test","content":[],
                "stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}})
        ),
        sse(
            "content_block_start",
            &json!({"type":"content_block_start","index":0,
                "content_block":{"type":"tool_use","id":"toolu_guard","name":"lookup","input":{}}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":0,
                "delta":{"type":"input_json_delta","partial_json":"{\"q\":\"guard\"}"}})
        ),
        sse(
            "content_block_stop",
            &json!({"type":"content_block_stop","index":0})
        ),
        sse(
            "message_delta",
            &json!({"type":"message_delta",
                "delta":{"stop_reason":"tool_use","stop_sequence":null},
                "usage":{"output_tokens":1}})
        ),
        sse("message_stop", &json!({"type":"message_stop"}))
    )
}

#[derive(Debug)]
struct ConsumedResponse {
    status: Option<StatusCode>,
    version: Option<reqwest::Version>,
    body: String,
    transport_error: Option<String>,
}

async fn consume_response(result: Result<reqwest::Response, reqwest::Error>) -> ConsumedResponse {
    match result {
        Err(error) => ConsumedResponse {
            status: None,
            version: None,
            body: String::new(),
            transport_error: Some(error.to_string()),
        },
        Ok(mut response) => {
            let status = Some(response.status());
            let version = Some(response.version());
            let mut body = Vec::new();
            let mut transport_error = None;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(error) => {
                        transport_error = Some(error.to_string());
                        break;
                    }
                }
            }
            ConsumedResponse {
                status,
                version,
                body: String::from_utf8_lossy(&body).into_owned(),
                transport_error,
            }
        }
    }
}

struct EntryOptions {
    memory_project_root: Option<std::path::PathBuf>,
    health_enabled: bool,
    status_override: Option<StatusCode>,
    mixed: Option<MixedRoundtrip>,
    attempt_bodies: Vec<String>,
    attempt_statuses: Vec<StatusCode>,
    auth_entries: Vec<(String, String)>,
    pin_key: Option<String>,
    execution_mode: Option<String>,
    capture_headers: bool,
    model_key: Option<String>,
    wire_model: Option<String>,
    live_forward: Option<LiveForward>,
    two_provider_route: bool,
    hold_attempt_open: bool,
    /// Test-only injection of the typed Chat Process refill limit.
    ///
    /// The harness default pins `Some(0)` so a test whose subject is not
    /// refill keeps single-attempt accounting. Pass `None` to run the compiled
    /// policy (`max_consecutive_refills = 1`), which is the real default; pass
    /// `Some(n)` to pin a different typed limit.
    refill_max: Option<u32>,
}

impl Default for EntryOptions {
    fn default() -> Self {
        Self {
            memory_project_root: None,
            health_enabled: false,
            status_override: None,
            mixed: None,
            attempt_bodies: Vec::new(),
            attempt_statuses: Vec::new(),
            auth_entries: Vec::new(),
            pin_key: None,
            execution_mode: None,
            capture_headers: false,
            model_key: None,
            wire_model: None,
            live_forward: None,
            two_provider_route: false,
            hold_attempt_open: false,
            refill_max: Some(0),
        }
    }
}

async fn start_entry(
    kind: &str,
    process: &str,
    status: StatusCode,
    content_type: &'static str,
    body: String,
) -> (
    String,
    V3ServerAggregateHandle,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
) {
    let (endpoint, handle, captures, _headers, shutdown) = start_entry_configured(
        kind,
        process,
        status,
        content_type,
        body,
        EntryOptions::default(),
    )
    .await;
    (endpoint, handle, captures, shutdown)
}

async fn start_entry_with_health(
    kind: &str,
    process: &str,
    status: StatusCode,
    content_type: &'static str,
    body: String,
    health_enabled: bool,
) -> (
    String,
    V3ServerAggregateHandle,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
) {
    let (endpoint, handle, captures, _headers, shutdown) = start_entry_configured(
        kind,
        process,
        status,
        content_type,
        body,
        EntryOptions {
            health_enabled,
            ..EntryOptions::default()
        },
    )
    .await;
    (endpoint, handle, captures, shutdown)
}

async fn start_entry_fixture(
    kind: &str,
    process: &str,
    status: StatusCode,
    content_type: &'static str,
    body: String,
    health_enabled: bool,
    mixed: Option<MixedRoundtrip>,
) -> (
    String,
    V3ServerAggregateHandle,
    mpsc::UnboundedReceiver<Value>,
    oneshot::Sender<()>,
) {
    let (endpoint, handle, captures, _headers, shutdown) = start_entry_configured(
        kind,
        process,
        status,
        content_type,
        body,
        EntryOptions {
            health_enabled,
            mixed,
            ..EntryOptions::default()
        },
    )
    .await;
    (endpoint, handle, captures, shutdown)
}

async fn start_entry_configured(
    kind: &str,
    process: &str,
    status: StatusCode,
    content_type: &'static str,
    body: String,
    options: EntryOptions,
) -> (
    String,
    V3ServerAggregateHandle,
    mpsc::UnboundedReceiver<Value>,
    Option<mpsc::UnboundedReceiver<String>>,
    oneshot::Sender<()>,
) {
    let EntryOptions {
        memory_project_root,
        health_enabled,
        status_override,
        attempt_bodies,
        attempt_statuses,
        auth_entries,
        pin_key,
        execution_mode,
        capture_headers,
        mixed,
        model_key,
        wire_model,
        live_forward,
        two_provider_route,
        hold_attempt_open,
        refill_max,
    } = options;
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("public regression requires loopback sockets");
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (header_tx, header_rx) = mpsc::unbounded_channel::<String>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .route("/v1/chat/completions", post(controlled_upstream))
        .route("/v1/messages", post(controlled_upstream))
        .fallback(post(controlled_upstream))
        .with_state(Arc::new(ProviderState {
            kind: kind.to_string(),
            health_enabled,
            status_override,
            status,
            content_type,
            body,
            captures: captures_tx,
            attempt_bodies,
            attempts: std::sync::atomic::AtomicUsize::new(0),
            attempt_statuses,
            header_captures: capture_headers.then_some(header_tx),
            mixed,
            live_forward,
            hold_attempt_open,
        }));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let declaration = match execution_mode.as_deref() {
        Some("relay") => {
            let direct_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
            let relay_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
            hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding)
        }
        _ => hub_v1_fixture::hub_v1_test_declaration(),
    };
    let execution = hub_v1_fixture::hub_v1_server_execution("a");
    // Apply the typed refill policy for this entry after the shared fixture has
    // prepared the process. `None` clears the injection so the compiled
    // `internal.toml` value is the only active source.
    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(refill_max);
    let port = test_ports::free_port();
    let auth_entries = if auth_entries.is_empty() {
        let alias = if health_enabled {
            format!("representation-key-{port}")
        } else {
            "key".to_string()
        };
        vec![(alias, KEY_ENV.to_string())]
    } else {
        auth_entries
    };
    let auth_entries_toml = auth_entries
        .iter()
        .map(|(alias, env)| format!("{{ alias = \"{alias}\", env = \"{env}\" }}"))
        .collect::<Vec<_>>()
        .join(", ");
    let pin_key = if pin_key.is_none() && auth_entries.len() == 1 {
        Some(auth_entries[0].0.clone())
    } else {
        pin_key
    };
    let target_key = pin_key
        .as_ref()
        .map(|key| format!(", key = \"{key}\""))
        .unwrap_or_default();
    let model_key = model_key.as_deref().unwrap_or("test");
    let wire_model = wire_model.as_deref().unwrap_or("wire-test");
    // Anthropic's transport appends /v1/messages; Responses and Chat append
    // their endpoint to an API base that already includes /v1.
    let provider_base_url = if kind == "anthropic" {
        format!("http://{upstream_addr}")
    } else {
        format!("http://{upstream_addr}/v1")
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.a]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses", "openai_chat", "anthropic", "gemini"]
{execution}
[providers.test]
type = "{kind}"
base_url = "{provider_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{auth_entries_toml}] }}
health = {{ enabled = {health_enabled}, failure_threshold = 2, cooldown_ms = 5000 }}
responses = {{ process = "{process}", streaming = "always" }}
        [providers.test.models."{model_key}"]
wire_name = "{wire_model}"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[providers.independent]
type = "responses"
base_url = "http://{upstream_addr}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always" }}
[providers.independent.models.test]
wire_name = "wire-independent"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "{model_key}"{target_key}, priority = 1 }}]
"#
    );
    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    if two_provider_route {
        let pool = manifest
            .route_groups
            .get_mut("default")
            .unwrap()
            .pools
            .get_mut("default")
            .unwrap();
        pool.targets[0].priority = Some(10);
        let mut second = pool.targets[0].clone();
        second.provider = Some("independent".into());
        second.key = Some("key".into());
        second.priority = Some(1);
        pool.targets.push(second);
    }
    if let Some(root) = memory_project_root {
        manifest.memory_raw_capture.enabled = true;
        manifest.memory_raw_capture.project_root = root;
    }
    if let Ok(path) = std::env::var("V3_NO_RESPONSE_TEST_LOG_FILE") {
        manifest.debug.log_file = Some(path);
        manifest.debug.log_console = true;
        manifest.debug.snapshots = true;
        manifest.debug.codex_samples = true;
        manifest.debug.full_codex_sampling = true;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    (
        format!("http://{}/v1/responses", handle.listeners[0].addr),
        handle,
        captures_rx,
        capture_headers.then_some(header_rx),
        shutdown_tx,
    )
}

async fn stop_entry(handle: V3ServerAggregateHandle, shutdown: oneshot::Sender<()>) {
    handle.shutdown().await;
    let _ = shutdown.send(());
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap()
}

async fn post_request(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    client.post(endpoint).json(&json!({"model":model,"input":"controlled response regression","stream":true,
        "tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}]})).send().await
}

fn events(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|data| !data.is_empty() && *data != "[DONE]")
        .map(|data| serde_json::from_str(data).expect("client SSE must preserve valid JSON"))
        .collect()
}

/// Test-local Anthropic SSE consumer that mirrors the real client's incremental
/// contract: a tool block's `content_block_start.input` is discarded and the
/// arguments are accumulated only from matching `input_json_delta` frames.
fn anthropic_sse_content_blocks(body: &str) -> Vec<Value> {
    let frames = events(body);
    let mut blocks = Vec::new();
    let mut indexes = Vec::new();
    for frame in &frames {
        if frame["type"] != "content_block_start" {
            continue;
        }
        let mut block = frame["content_block"].clone();
        if block["type"] == "tool_use" {
            // Ignore any populated start input, exactly like the observed client.
            block["input"] = json!({});
        }
        indexes.push(frame["index"].as_u64().expect("content block index"));
        blocks.push(block);
    }
    for (position, index) in indexes.iter().enumerate() {
        if blocks[position]["type"] != "tool_use" {
            continue;
        }
        let partial = anthropic_tool_input_partial_json(&frames, *index);
        assert!(
            !partial.is_empty(),
            "missing input_json_delta for tool block {index}: {body}"
        );
        blocks[position]["input"] = serde_json::from_str(&partial).unwrap_or_else(|error| {
            panic!("tool input delta must reconstruct JSON for block {index}: {error}: {partial:?}")
        });
    }
    blocks
}

fn anthropic_tool_input_partial_json(frames: &[Value], index: u64) -> String {
    frames
        .iter()
        .filter(|frame| frame["type"] == "content_block_delta" && frame["index"] == index)
        .filter(|frame| frame["delta"]["type"] == "input_json_delta")
        .filter_map(|frame| frame["delta"]["partial_json"].as_str())
        .collect()
}

/// Reasoning representations remain lossless alongside deliverable body text.
#[tokio::test]
async fn b878f6c_chat_reasoning_business_shapes_survive_json_admission() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let shapes = [
        (
            "reasoning",
            json!({"summary":[{"type":"summary_text","text":"preserved plan"}]}),
        ),
        (
            "reasoning",
            json!({"content":[{"type":"reasoning_text","text":"preserved plan"}]}),
        ),
        ("reasoning", json!({"encrypted_content":"preserved cipher"})),
        ("reasoning_content", json!([{"text":"preserved plan"}])),
        (
            "reasoning_content",
            json!({"content":[{"text":"preserved plan"}]}),
        ),
        ("reasoning_text", json!("preserved plan")),
    ];
    for (entry, process) in [
        ("responses", "chat"),
        ("openai_chat", "direct"),
        ("openai_chat", "chat"),
    ] {
        for (field, reasoning) in &shapes {
            let mut upstream = json!({"id":"reasoning-control","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"visible reasoning control"},"finish_reason":"stop"}]});
            upstream["choices"][0]["message"][field] = reasoning.clone();
            let (endpoint, handle, mut captures, shutdown) = start_entry_with_health(
                "openai_chat",
                process,
                StatusCode::OK,
                "application/json",
                upstream.to_string(),
                true,
            )
            .await;
            let base = endpoint.trim_end_matches("/v1/responses");
            let request = if entry == "responses" {
                json!({"model":"test.test","input":"representation-invalid-reasoning-control","stream":false})
            } else {
                json!({"model":"test.test","messages":[{"role":"user","content":"representation-invalid-reasoning-control"}],"stream":false})
            };
            let path = if entry == "responses" {
                "/v1/responses"
            } else {
                "/v1/chat/completions"
            };
            let (_, body) = successful_transfer(
                client()
                    .post(format!("{base}{path}"))
                    .json(&request)
                    .send()
                    .await,
            )
            .await;
            assert!(
                body.contains("preserved"),
                "{entry}/{process}/{field}: {body}"
            );
            if entry == "openai_chat" {
                let delivered: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(
                    delivered["choices"][0]["message"][field], *reasoning,
                    "{process}: {body}"
                );
            }
            let health: Value = client()
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(
                health["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row["provider_id"] != "test"),
                "{health}"
            );
            stop_entry(handle, shutdown).await;
            let mut business_attempts = 0;
            while let Some(capture) = captures.recv().await {
                if capture
                    .to_string()
                    .contains("representation-invalid-reasoning-control")
                {
                    business_attempts += 1;
                }
            }
            assert_eq!(business_attempts, 1, "reasoning must not reselect");
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// b878f6c review regression: filtering is a Gemini business result, empty STOP is not.
#[tokio::test]
async fn b878f6c_gemini_filtering_json_sse_preserves_terminal_without_reselection() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for streaming in [false, true] {
        for reason in [
            "SAFETY",
            "RECITATION",
            "BLOCKLIST",
            "PROHIBITED_CONTENT",
            "SPII",
            "STOP",
        ] {
            eprintln!("Gemini filtering control: stream={streaming} reason={reason}");
            let expected = json!({"candidates":[{"index":0,"content":{"role":"model","parts":[]},"finishReason":reason}]});
            let upstream = if streaming {
                format!("data: {expected}\n\n")
            } else {
                expected.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "gemini",
                "direct",
                StatusCode::OK,
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                upstream,
            )
            .await;
            let base = endpoint.trim_end_matches("/v1/responses");
            let action = "generateContent";
            let request = json!({"contents":[{"role":"user","parts":[{"text":"filter control"}]}],"stream":streaming});
            let response = client()
                .post(format!("{base}/v1beta/models/test.test/{action}"))
                .json(&request)
                .send()
                .await;
            if reason == "STOP" {
                assert_incomplete_transport(response).await;
            } else {
                let (_, body) = successful_transfer(response).await;
                assert!(
                    body.contains(reason),
                    "provider filtering must survive: {body}"
                );
                let health: Value = client()
                    .get(format!("{base}/_routecodex/health/cooldown-pool"))
                    .send()
                    .await
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
                assert!(
                    health["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|row| row["provider_id"] != "test"),
                    "{health}"
                );
            }
            stop_entry(handle, shutdown).await;
            let mut business_attempts = 0;
            while let Some(capture) = captures.recv().await {
                if capture.to_string().contains("filter control") {
                    business_attempts += 1;
                }
            }
            assert_eq!(business_attempts, 1);
        }
    }
    for feedback in [
        json!({"candidates":[],"promptFeedback":{"blockReason":"SAFETY"}}),
        json!({"promptFeedback":{"blockReason":"SAFETY"}}),
    ] {
        for streaming in [false, true] {
            eprintln!("Gemini prompt feedback control: {feedback}");
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "gemini",
                "direct",
                StatusCode::OK,
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                if streaming {
                    format!("data: {feedback}\n\n")
                } else {
                    feedback.to_string()
                },
            )
            .await;
            let base = endpoint.trim_end_matches("/v1/responses");
            let (_, body) = successful_transfer(
            client()
                .post(format!("{base}/v1beta/models/test.test/generateContent"))
                .json(&json!({"contents":[{"role":"user","parts":[{"text":"filter control"}]}],"stream":streaming}))
                .send()
                .await,
        )
        .await;
            assert!(body.contains("SAFETY"), "{body}");
            stop_entry(handle, shutdown).await;
            assert!(captures.recv().await.is_some());
            assert!(
                captures.try_recv().is_err(),
                "filter feedback must not retry"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable RED ID: an explicit Gemini Relay (JSON and SSE) provider filter
/// terminal whose candidate carries genuinely missing `content` must survive
/// the codec instead of becoming a local PartsNotArray failure. The fixture is
/// the real accepted shape `{"candidates":[{"index":0,"finishReason":"SAFETY"}]}`;
/// no synthetic content/parts are inserted. The ordinary empty STOP control
/// stays an incomplete transport (internal 502), not a fabricated success.
#[tokio::test]
async fn b878f6c_gemini_relay_filtering_candidate_without_content_preserves_terminal() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for streaming in [false, true] {
        for reason in ["SAFETY", "RECITATION"] {
            eprintln!(
                "Gemini relay filtering candidate control: stream={streaming} reason={reason}"
            );
            let expected = json!({"candidates":[{"index":0,"finishReason":reason}]});
            let upstream = if streaming {
                format!("data: {expected}\n\n")
            } else {
                expected.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "gemini",
                "relay",
                StatusCode::OK,
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                upstream,
            )
            .await;
            let base = endpoint.trim_end_matches("/v1/responses");
            let request = json!({"contents":[{"role":"user","parts":[{"text":"filter control"}]}],"stream":streaming});
            let response = client()
                .post(format!("{base}/v1beta/models/test.test/generateContent"))
                .json(&request)
                .send()
                .await;
            let (_, body) = successful_transfer(response).await;
            assert!(
                body.contains(reason),
                "provider filter terminal must survive explicit Relay: {body}"
            );
            let payload: Value = if streaming {
                body.lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
                    .find(|value| value.get("candidates").is_some())
                    .expect("Relay SSE must contain the real filtering candidate")
            } else {
                serde_json::from_str(&body).unwrap()
            };
            assert_eq!(payload["candidates"], expected["candidates"]);
            let health: Value = client()
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(
                health["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row["provider_id"] != "test"),
                "filter terminal must not cool the provider identity: {health}"
            );
            stop_entry(handle, shutdown).await;
            let mut business_attempts = 0;
            while let Some(capture) = captures.recv().await {
                if capture.to_string().contains("filter control") {
                    business_attempts += 1;
                }
            }
            assert_eq!(
                business_attempts, 1,
                "filter terminal must deliver on the first business attempt without reselection"
            );
        }
    }
    // Ordinary empty STOP stays a genuine empty attempt: the transport
    // terminates without a fabricated completion and without cooling the
    // healthy identity.
    for streaming in [false, true] {
        eprintln!("Gemini relay ordinary empty STOP control: stream={streaming}");
        let expected = json!({"candidates":[{"index":0,"content":{"role":"model","parts":[]},"finishReason":"STOP"}]});
        let upstream = if streaming {
            format!("data: {expected}\n\n")
        } else {
            expected.to_string()
        };
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "gemini",
            "relay",
            StatusCode::OK,
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
            upstream,
        )
        .await;
        let base = endpoint.trim_end_matches("/v1/responses");
        let request = json!({"contents":[{"role":"user","parts":[{"text":"filter control"}]}],"stream":streaming});
        let response = client()
            .post(format!("{base}/v1beta/models/test.test/generateContent"))
            .json(&request)
            .send()
            .await;
        assert_incomplete_transport(response).await;
        let health: Value = client()
            .get(format!("{base}/_routecodex/health/cooldown-pool"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            health["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["provider_id"] != "test"),
            "genuine empty STOP must not cool the provider identity: {health}"
        );
        stop_entry(handle, shutdown).await;
        let mut business_attempts = 0;
        while let Some(capture) = captures.recv().await {
            if capture.to_string().contains("filter control") {
                business_attempts += 1;
            }
        }
        assert_eq!(business_attempts, 1);
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn b878f6c_compact_responses_message_fields_are_business_content() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for streaming in [false, true] {
        for with_reasoning in [false, true] {
            eprintln!(
                "compact message control: stream={streaming} with_reasoning={with_reasoning}"
            );
            let item = if with_reasoning {
                json!({"id":"compact-message","type":"message","role":"assistant",
                    "text":"compact answer","reasoning_content":"compact reasoning"})
            } else {
                json!({"id":"compact-message","type":"message","role":"assistant",
                    "text":"compact answer"})
            };
            let expected = json!({"id":"compact-response","object":"response",
                "status":"completed","output":[item]});
            let upstream = if streaming {
                format!(
                    "event: response.completed\ndata: {}\n\n",
                    json!({"type":"response.completed","response":expected})
                )
            } else {
                expected.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                "direct",
                StatusCode::OK,
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                upstream,
            )
            .await;
            let response = client()
                .post(&endpoint)
                .json(&json!({
                    "model":"test.test","input":"compact control","stream":streaming,
                }))
                .send()
                .await;
            let (_, body) = successful_transfer(response).await;
            let payload: Value = if streaming {
                body.lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
                    .find_map(|event| event.get("response").cloned())
                    .expect("compact terminal must reach the actual consumer")
            } else {
                serde_json::from_str(&body).unwrap()
            };
            assert_eq!(payload["output"], expected["output"]);
            let base = endpoint.trim_end_matches("/v1/responses");
            let health: Value = client()
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(health["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["provider_id"] != "test"));
            stop_entry(handle, shutdown).await;
            let mut attempts = 0;
            while let Some(capture) = captures.recv().await {
                if capture.to_string().contains("compact control") {
                    attempts += 1;
                }
            }
            assert_eq!(attempts, 1);
        }
    }
    for streaming in [false, true] {
        let empty = json!({"id":"empty-compact","object":"response","status":"completed",
            "output":[{"type":"message","text":"","reasoning_content":""}]});
        let upstream = if streaming {
            format!(
                "event: response.completed\ndata: {}\n\n",
                json!({"type":"response.completed","response":empty})
            )
        } else {
            empty.to_string()
        };
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "direct",
            StatusCode::OK,
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
            upstream,
        )
        .await;
        assert_incomplete_transport(
            client()
                .post(endpoint)
                .json(&json!({
                    "model":"test.test","input":"empty compact control","stream":streaming,
                }))
                .send()
                .await,
        )
        .await;
        stop_entry(handle, shutdown).await;
        let mut attempts = 0;
        while let Some(capture) = captures.recv().await {
            if capture.to_string().contains("empty compact control") {
                attempts += 1;
            }
        }
        assert_eq!(attempts, 1);
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn b878f6c_compact_responses_reach_real_chat_consumer() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for streaming in [false, true] {
        for (item, expected_text, expected_reasoning) in [
            (
                json!({"type":"message","role":"assistant","text":"compact answer"}),
                "compact answer",
                "",
            ),
            (
                json!({"type":"message","role":"assistant","text":"compact answer","reasoning_content":"  compact reasoning\n"}),
                "compact answer",
                "  compact reasoning\n",
            ),
            (
                json!({"type":"message","role":"assistant","text":"compact answer","reasoning":"  compact reasoning\n"}),
                "compact answer",
                "  compact reasoning\n",
            ),
            (
                json!({"type":"message","role":"assistant","text":"compact answer","reasoning":{"summary":[{"type":"summary_text","text":"  compact reasoning\n"}]}}),
                "compact answer",
                "  compact reasoning\n",
            ),
            (
                json!({"type":"message","role":"assistant","text":"compact answer","reasoning":{"content":[{"type":"reasoning_text","text":"  compact reasoning\n"}]}}),
                "compact answer",
                "  compact reasoning\n",
            ),
            (
                json!({"type":"message","role":"assistant","text":"compact answer","reasoning_text":"  compact reasoning\n"}),
                "compact answer",
                "  compact reasoning\n",
            ),
            (
                json!({"type":"message","role":"assistant","text":"compact answer","content":[{"type":"output_text","text":"compact answer"}],"reasoning_content":"compact reasoning","extension":{"keep":true}}),
                "compact answer",
                "compact reasoning",
            ),
        ] {
            let response = json!({"id":"compact-chat","object":"response","status":"completed","output":[item]});
            let upstream = if streaming {
                response_sse(&response)
            } else {
                response.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                "chat",
                StatusCode::OK,
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                upstream,
            )
            .await;
            let chat_endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
            let (client_content_type, body) = successful_transfer(client().post(&chat_endpoint).json(&json!({
                "model":"test.test","messages":[{"role":"user","content":"compact chat consumer"}],"stream":streaming
            })).send().await).await;
            let health: Value = client()
                .get(format!(
                    "{}/_routecodex/health/cooldown-pool",
                    endpoint.trim_end_matches("/v1/responses")
                ))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            assert!(health["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["provider_id"] != "test"));
            assert!(client_content_type.starts_with(if streaming {
                "text/event-stream"
            } else {
                "application/json"
            }));
            let (text, reasoning, terminal) = if streaming {
                let frames = events(&body);
                assert!(body.contains("data: [DONE]"), "{body}");
                (
                    frames
                        .iter()
                        .filter_map(|frame| frame["choices"][0]["delta"]["content"].as_str())
                        .collect::<String>(),
                    frames
                        .iter()
                        .filter_map(|frame| {
                            frame["choices"][0]["delta"]["reasoning_content"].as_str()
                        })
                        .collect::<String>(),
                    frames
                        .iter()
                        .any(|frame| frame["choices"][0]["finish_reason"] == "stop"),
                )
            } else {
                let payload: Value = serde_json::from_str(&body).unwrap();
                (
                    payload["choices"][0]["message"]["content"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    payload["choices"][0]["message"]["reasoning_content"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    payload["choices"][0]["finish_reason"] == "stop",
                )
            };
            assert_eq!(text, expected_text, "stream={streaming}: {body}");
            assert_eq!(reasoning, expected_reasoning, "stream={streaming}: {body}");
            assert!(terminal, "stream={streaming}: {body}");
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn duplicate_tool_ids_preserve_both_calls_across_public_entries() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (custom, same_item_id) in [(false, false), (false, true), (true, false), (true, true)] {
        let calls: Vec<Value> = (0..2).map(|index| {
            let mut item = json!({"type":if custom {"custom_tool_call"} else {"function_call"},
                "id":format!("item_{}",if same_item_id {0} else {index}),"call_id":"same_call","name":format!("lookup{index}"),"status":"completed"});
            item[if custom {"input"} else {"arguments"}] = json!(if custom {
                format!(" raw {index}\ncomplete input ")
            } else { format!("{{\"q\":\"complete {index}\",\"nested\":{{\"value\":{index}}}}}") });
            item
        }).collect();
        let native = json!({"id":"resp_duplicate","object":"response","status":"completed","model":"wire-test","output":calls});
        for entry in ["responses", "openai_chat", "anthropic"] {
            for streaming in [false, true] {
                for upstream_type in if streaming {
                    vec!["application/json", "text/event-stream"]
                } else {
                    vec!["application/json"]
                } {
                    let upstream = if upstream_type == "application/json" {
                        native.to_string()
                    } else {
                        response_sse(&native)
                    };
                    let (endpoint, handle, mut captures, shutdown) =
                        start_entry("responses", "chat", StatusCode::OK, upstream_type, upstream)
                            .await;
                    let endpoint = endpoint.replace(
                        "/v1/responses",
                        match entry {
                            "openai_chat" => "/v1/chat/completions",
                            "anthropic" => "/v1/messages",
                            _ => "/v1/responses",
                        },
                    );
                    let request = if entry == "responses" {
                        json!({"model":"test.test","stream":streaming,"input":"preserve both calls"})
                    } else {
                        json!({"model":"test.test","stream":streaming,"max_tokens":100,"messages":[{"role":"user","content":"preserve both calls"}]})
                    };
                    let (content_type, body) =
                        successful_transfer(client().post(endpoint).json(&request).send().await)
                            .await;
                    stop_entry(handle, shutdown).await;
                    assert_one_attempt(&mut captures, "wire-test").await;
                    let projected_sse = content_type.starts_with("text/event-stream");
                    let payloads = if content_type.contains("application/json") {
                        vec![serde_json::from_str::<Value>(&body).unwrap()]
                    } else {
                        events(&body)
                    };
                    if entry == "responses" {
                        let value = if projected_sse {
                            &payloads
                                .iter()
                                .find(|event| event["type"] == "response.completed")
                                .unwrap()["response"]
                        } else {
                            &payloads[0]
                        };
                        assert_eq!(value["output"], native["output"], "{body}");
                    } else if entry == "anthropic" {
                        let blocks: Vec<Value> = if projected_sse {
                            anthropic_sse_content_blocks(&body)
                        } else {
                            payloads[0]["content"].as_array().unwrap().clone()
                        };
                        assert_eq!(blocks.len(), 2, "{body}");
                        for index in 0..2 {
                            assert_eq!(blocks[index]["id"], "same_call", "{body}");
                            assert_eq!(blocks[index]["name"], calls[index]["name"], "{body}");
                            let expected = if custom {
                                json!({"input":calls[index]["input"]})
                            } else {
                                serde_json::from_str(calls[index]["arguments"].as_str().unwrap())
                                    .unwrap()
                            };
                            assert_eq!(blocks[index]["input"], expected, "{body}");
                        }
                    } else {
                        let tools: Vec<Value> = if projected_sse {
                            payloads
                                .iter()
                                .filter_map(|event| {
                                    event["choices"][0]["delta"]["tool_calls"].as_array()
                                })
                                .flatten()
                                .cloned()
                                .collect()
                        } else {
                            payloads[0]["choices"][0]["message"]["tool_calls"]
                                .as_array()
                                .unwrap()
                                .clone()
                        };
                        for index in 0..2 {
                            let parts: Vec<&Value> = if projected_sse {
                                tools.iter().filter(|tool| tool["index"] == index).collect()
                            } else {
                                vec![&tools[index]]
                            };
                            assert!(
                                parts.iter().any(|tool| tool["id"] == "same_call"
                                    && tool["function"]["name"] == calls[index]["name"]),
                                "{body}"
                            );
                            let arguments: String = parts
                                .iter()
                                .filter_map(|tool| tool["function"]["arguments"].as_str())
                                .collect();
                            let expected = if custom {
                                json!({"input":calls[index]["input"]}).to_string()
                            } else {
                                calls[index]["arguments"].as_str().unwrap().to_string()
                            };
                            assert_eq!(arguments, expected, "{body}");
                        }
                        if !projected_sse {
                            assert_eq!(tools.len(), 2, "{body}");
                        }
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

async fn assert_one_attempt(captures: &mut mpsc::UnboundedReceiver<Value>, wire_model: &str) {
    let request = tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .expect("real upstream attempt")
        .unwrap();
    assert_eq!(request["model"], wire_model);
    assert!(
        matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ),
        "exactly one upstream attempt per request"
    );
}

/// Stable public regression: both mixed calls sharing an ID must survive
/// actual client tool execution and the next request in either order.
#[tokio::test]
async fn mixed_duplicate_tool_kinds_complete_public_roundtrip() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let tools = json!([
        {"type":"namespace","name":"functions","tools":[{"type":"function","name":"lookup",
            "parameters":{"type":"object","properties":{"left":{"type":"number"},"right":{"type":"number"}},"required":["left","right"]}}]},
        {"type":"namespace","name":"customs","tools":[{"type":"custom","name":"echo","format":{"type":"text"}}]}
    ]);
    let function = json!({"type":"function_call","id":"function_item","call_id":"dup",
        "namespace":"functions","name":"lookup","status":"completed","arguments":"{\"left\":2,\"right\":3}"});
    let custom = json!({"type":"custom_tool_call","id":"custom_item","call_id":"dup",
        "namespace":"customs","name":"echo","status":"completed","input":" exact raw\n input "});
    for reverse in [false, true] {
        let calls = if reverse {
            vec![custom.clone(), function.clone()]
        } else {
            vec![function.clone(), custom.clone()]
        };
        let native = json!({"id":"resp_mixed","object":"response","status":"completed","model":"wire-test","output":calls});
        let fixture = || {
            MixedRoundtrip {
            declarations: tools.as_array().unwrap().iter().map(|namespace| {
                let mut tool = namespace["tools"][0].clone();
                tool.as_object_mut().unwrap().remove("name");
                tool
            }).collect(),
            response: native.clone(),
            results: calls.iter().map(|call| if call == &function {
                json!({"type":"function_call_output","call_id":"dup","output":"{\"sum\":5}"})
            } else {
                json!({"type":"custom_tool_call_output","call_id":"dup","output":json!({"received":" exact raw\n input "}).to_string()})
            }).collect(),
        }
        };
        for process in ["direct", "chat"] {
            for streaming in [false, true] {
                let media: &[&str] = if streaming {
                    &["application/json", "text/event-stream"]
                } else {
                    &["application/json"]
                };
                for &upstream_type in media {
                    let (endpoint, handle, mut captures, shutdown) = start_entry_fixture(
                        "responses",
                        process,
                        StatusCode::OK,
                        upstream_type,
                        String::new(),
                        false,
                        Some(fixture()),
                    )
                    .await;
                    let initial = json!({"model":"test.test","input":"execute both declared tools","tools":tools,"stream":streaming});
                    let (content_type, body) =
                        successful_transfer(client().post(&endpoint).json(&initial).send().await)
                            .await;
                    let returned = if content_type.contains("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        events(&body)
                            .into_iter()
                            .find(|event| event["type"] == "response.completed")
                            .expect("genuine tool terminal")["response"]
                            .clone()
                    };
                    assert_eq!(
                        returned["output"], native["output"],
                        "{process}/{upstream_type}: {body}"
                    );
                    let first = captures.recv().await.expect("first provider declarations");
                    assert_eq!(first["model"], "wire-test");
                    let raw_calls = fixture()
                        .bound_calls(&first)
                        .expect("first declaration binding");
                    assert_eq!(raw_calls.len(), calls.len());
                    assert!(
                        matches!(captures.try_recv(), Err(mpsc::error::TryRecvError::Empty)),
                        "one first attempt"
                    );
                    let mut input = vec![
                        json!({"type":"message","role":"user","content":"execute both declared tools"}),
                    ];
                    input.extend(returned["output"].as_array().unwrap().iter().cloned());
                    for call in returned["output"].as_array().unwrap() {
                        let (kind, program, argument, expected) = if call["type"]
                            == function["type"]
                            && call["namespace"] == function["namespace"]
                            && call["name"] == function["name"]
                        {
                            ("function_call_output", "const a=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({sum:a.left+a.right}));", call["arguments"].as_str().unwrap(), "{\"sum\":5}".to_owned())
                        } else if call["type"] == custom["type"]
                            && call["namespace"] == custom["namespace"]
                            && call["name"] == custom["name"]
                        {
                            (
                                "custom_tool_call_output",
                                "process.stdout.write(JSON.stringify({received:process.argv[1]}));",
                                call["input"].as_str().unwrap(),
                                json!({"received":" exact raw\n input "}).to_string(),
                            )
                        } else {
                            panic!("undeclared client dispatch: {call}");
                        };
                        let receipt = std::process::Command::new("node")
                            .args(["-e", program, argument])
                            .output()
                            .unwrap();
                        assert!(
                            receipt.status.success(),
                            "client tool execution: {:?}",
                            receipt
                        );
                        let output = String::from_utf8(receipt.stdout).unwrap();
                        assert_eq!(output, expected);
                        input.push(json!({"type":kind,"call_id":call["call_id"],"output":output}));
                    }
                    let followup =
                        json!({"model":"test.test","input":input,"tools":tools,"stream":streaming});
                    let (content_type, body) =
                        successful_transfer(client().post(&endpoint).json(&followup).send().await)
                            .await;
                    stop_entry(handle, shutdown).await;
                    let wire = captures
                        .recv()
                        .await
                        .expect("both matching results reach provider");
                    assert_eq!(wire["model"], "wire-test");
                    let oracle = fixture();
                    assert!(
                        oracle.valid_followup(&wire),
                        "complete bound history: {wire}"
                    );
                    for mutation in 0..5 {
                        let mut invalid = wire.clone();
                        let items = invalid["input"].as_array_mut().unwrap();
                        let call = items
                            .iter()
                            .position(|item| item.get("name").is_some())
                            .unwrap();
                        let result = items
                            .iter()
                            .position(|item| item.get("output").is_some())
                            .unwrap();
                        match mutation {
                            0 => {
                                items[call]["name"] =
                                    json!(format!("{}\0", items[call]["name"].as_str().unwrap()));
                            }
                            1 => {
                                invalid["tools"][0]["parameters"] = json!({});
                            }
                            2 => {
                                invalid["tools"][0]["type"] = json!("custom");
                            }
                            3 => {
                                items.remove(result);
                            }
                            _ => {
                                items.swap(result, result + 1);
                            }
                        }
                        assert!(
                            !oracle.valid_followup(&invalid),
                            "accepted mutation {mutation}: {invalid}"
                        );
                    }
                    assert!(
                        matches!(
                            captures.try_recv(),
                            Err(mpsc::error::TryRecvError::Empty
                                | mpsc::error::TryRecvError::Disconnected)
                        ),
                        "one followup attempt"
                    );
                    let completed = if content_type.contains("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        events(&body)
                            .into_iter()
                            .find(|event| event["type"] == "response.completed")
                            .unwrap()["response"]
                            .clone()
                    };
                    assert_eq!(completed["status"], "completed");
                    assert_eq!(
                        completed["output"],
                        text_response("mixed roundtrip complete")["output"]
                    );
                    eprintln!(
                        "mixed wire evidence: {}",
                        json!({"process":process,"streaming":streaming,
                        "upstream_type":upstream_type,"first":first,"raw_calls":raw_calls,
                        "client":returned,"followup":wire,"consumer_results":oracle.results,
                        "rejected_mutations":["undeclared_name","schema","kind","missing_result","result_order"]})
                    );
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

async fn successful_transfer(
    result: Result<reqwest::Response, reqwest::Error>,
) -> (String, String) {
    let response = result.expect("representable response must reach client");
    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response.headers()["content-type"]
        .to_str()
        .unwrap()
        .to_string();
    let body = response
        .text()
        .await
        .expect("successful transfer must finish");
    (content_type, body)
}

async fn successful_body(result: Result<reqwest::Response, reqwest::Error>) -> String {
    let (content_type, body) = successful_transfer(result).await;
    assert!(content_type.starts_with("text/event-stream"));
    assert!(!events(&body).iter().any(|event| matches!(
        event["type"].as_str(),
        Some("error" | "response.failed" | "response.error")
    )));
    body
}

/// Stable RED ID: content_filter and unknown incomplete reasons must survive
/// Direct and explicit Relay, including partial output and the actual reason.
#[tokio::test]
async fn responses_incomplete_semantics_survive_direct_and_relay() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["direct", "chat"] {
        for reason in [
            "content_filter",
            "provider_specific_reason",
            "max_output_tokens",
        ] {
            let mut expected = text_response("retained partial text");
            expected["status"] = json!("incomplete");
            expected["incomplete_details"] = json!({"reason":reason});
            expected["output"][0]["status"] = json!("incomplete");
            for content_type in ["text/event-stream", "application/json"] {
                let upstream = if content_type == "application/json" {
                    expected.to_string()
                } else {
                    response_sse(&expected)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("responses", process, StatusCode::OK, content_type, upstream).await;
                let (actual_content_type, body) =
                    successful_transfer(post_request(&client(), &endpoint, "test.test").await)
                        .await;
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let terminal_response = if actual_content_type.starts_with("application/json") {
                    assert_eq!(process, "direct", "Relay must project the requested SSE");
                    assert_eq!(
                        content_type, "application/json",
                        "Direct preserves upstream framing"
                    );
                    let response: Value = serde_json::from_str(&body).expect("valid client JSON");
                    assert!(
                        response.get("error").is_none(),
                        "no client error envelope: {body}"
                    );
                    response
                } else {
                    assert!(actual_content_type.starts_with("text/event-stream"));
                    let payloads = events(&body);
                    assert!(
                        !payloads.iter().any(|event| matches!(
                            event["type"].as_str(),
                            Some(
                                "error"
                                    | "response.failed"
                                    | "response.error"
                                    | "response.completed"
                            )
                        )),
                        "incomplete cannot become failure or completed: {body}"
                    );
                    payloads
                        .iter()
                        .find(|event| event["type"] == "response.incomplete")
                        .expect("preserve incomplete terminal")["response"]
                        .clone()
                };
                assert_eq!(
                    terminal_response["status"], "incomplete",
                    "{process}/{reason}: {body}"
                );
                assert_eq!(
                    terminal_response["incomplete_details"],
                    expected["incomplete_details"]
                );
                assert_eq!(terminal_response["output"], expected["output"]);
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn responses_refusal_text_and_tool_controls_preserve_output() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let mut refusal = text_response("placeholder");
    refusal["output"][0]["content"] =
        json!([{"type":"refusal","refusal":"provider declined this request"}]);
    let mut tool = text_response("placeholder");
    tool["output"] = json!([{"type":"function_call","id":"fc_control","call_id":"call_control","name":"lookup","arguments":"{\"q\":\"retained\"}","status":"completed"}]);
    for process in ["direct", "chat"] {
        for expected in [&refusal, &text_response("ordinary successful text"), &tool] {
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                process,
                StatusCode::OK,
                "text/event-stream",
                response_sse(expected),
            )
            .await;
            let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let payloads = events(&body);
            let terminal = payloads
                .iter()
                .find(|event| event["type"] == "response.completed")
                .expect("control completes");
            assert_eq!(
                terminal["response"]["output"], expected["output"],
                "{process}: {body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable public regression ID: Responses-wire refusal and content_filter keep
/// their representable content and terminal semantics on Chat/Anthropic entries.
#[tokio::test]
async fn responses_wire_representation_survives_chat_and_anthropic_entries() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for entry in ["openai_chat", "anthropic"] {
        for streaming in [false, true] {
            for case in [
                "plain",
                "refusal",
                "content_filter",
                "max_output_tokens",
                "provider_specific_reason",
                "missing_details",
                "null_details",
                "empty_reason",
                "numeric_reason",
                "unknown_details",
                "whitespace_reason",
                "empty_completed",
            ] {
                let mut expected = text_response("NATIVE_OK");
                expected["usage"] = json!({"input_tokens":3,"output_tokens":2,"total_tokens":5});
                if case == "refusal" {
                    expected["output"][0]["content"] =
                        json!([{"type":"refusal","refusal":"NATIVE_REFUSAL"}]);
                } else if case != "plain" {
                    expected["status"] = json!("incomplete");
                    expected["incomplete_details"] = json!({"reason":case});
                    match case {
                        "missing_details" => {
                            expected
                                .as_object_mut()
                                .unwrap()
                                .remove("incomplete_details");
                        }
                        "null_details" => expected["incomplete_details"] = Value::Null,
                        "empty_reason" => expected["incomplete_details"] = json!({"reason":""}),
                        "numeric_reason" => expected["incomplete_details"] = json!({"reason":42}),
                        "unknown_details" => {
                            expected["incomplete_details"] = json!({"opaque":true})
                        }
                        "whitespace_reason" => {
                            expected["incomplete_details"] = json!({"reason":" content_filter "})
                        }
                        "empty_completed" => {
                            expected["status"] = json!("completed");
                            expected["output"] = json!([]);
                            expected
                                .as_object_mut()
                                .unwrap()
                                .remove("incomplete_details");
                        }
                        _ => {}
                    }
                }
                // Non-streaming provider requests require JSON. Streaming
                // requests may return either JSON or SSE under the transport contract.
                let upstream_types: &[&str] = if streaming {
                    &["application/json", "text/event-stream"]
                } else {
                    &["application/json"]
                };
                for &upstream_type in upstream_types {
                    let upstream = if upstream_type == "application/json" {
                        expected.to_string()
                    } else {
                        response_sse(&expected)
                    };
                    let (responses_endpoint, handle, mut captures, shutdown) =
                        start_entry("responses", "chat", StatusCode::OK, upstream_type, upstream)
                            .await;
                    let path = if entry == "openai_chat" {
                        "/v1/chat/completions"
                    } else {
                        "/v1/messages"
                    };
                    let endpoint = format!(
                        "{}{path}",
                        responses_endpoint.trim_end_matches("/v1/responses")
                    );
                    let mut request = json!({"model":"test.test", "stream":streaming,
                        "messages":[{"role":"user","content":"representation regression"}]});
                    if entry == "anthropic" {
                        request["max_tokens"] = json!(128);
                    } else if streaming {
                        request["stream_options"] = json!({"include_usage":true});
                    }
                    if case == "empty_completed" {
                        // v8 user contract (requirements v8 active):
                        // "上游的空响应 我们直接判为502 错误重试走错误链".
                        // A complete provider attempt with no deliverable
                        // business content is an internal 502 in the Error
                        // chain. The client gets neither a normal empty
                        // completion nor an error payload; only the transport
                        // terminates.
                        assert_incomplete_transport(
                            client().post(endpoint).json(&request).send().await,
                        )
                        .await;
                        stop_entry(handle, shutdown).await;
                        assert_one_attempt(&mut captures, "wire-test").await;
                        continue;
                    }
                    let (content_type, body) =
                        successful_transfer(client().post(endpoint).json(&request).send().await)
                            .await;
                    stop_entry(handle, shutdown).await;
                    assert_one_attempt(&mut captures, "wire-test").await;
                    assert!(!body.contains("\"error\""), "{entry}/{case}: {body}");
                    let expected_text = if case == "refusal" {
                        "NATIVE_REFUSAL"
                    } else {
                        "NATIVE_OK"
                    };
                    let expected_finish = match (entry, case) {
                        ("openai_chat", "plain" | "refusal") => json!("stop"),
                        ("openai_chat", "max_output_tokens") => json!("length"),
                        ("openai_chat", _) => expected["incomplete_details"]["reason"]
                            .as_str()
                            .map(|reason| json!(reason))
                            .unwrap_or(Value::Null),
                        (_, "content_filter") => json!("refusal"),
                        (_, "max_output_tokens") => json!("max_tokens"),
                        _ => json!("end_turn"),
                    };
                    if content_type.starts_with("application/json") {
                        let payload: Value = serde_json::from_str(&body).unwrap();
                        if entry == "openai_chat" {
                            let message = &payload["choices"][0]["message"];
                            assert_eq!(
                                message[if case == "refusal" {
                                    "refusal"
                                } else {
                                    "content"
                                }],
                                expected_text
                            );
                            assert_eq!(payload["choices"][0]["finish_reason"], expected_finish);
                            assert_eq!(payload["id"], "resp_control");
                            assert_eq!(payload["usage"]["prompt_tokens"], 3);
                            assert_eq!(payload["usage"]["completion_tokens"], 2);
                        } else {
                            assert_eq!(payload["content"][0]["text"], expected_text);
                            assert_eq!(payload["stop_reason"], expected_finish);
                            assert_eq!(payload["id"], "msg_control");
                            assert_eq!(payload["usage"]["input_tokens"], 3);
                            assert_eq!(payload["usage"]["output_tokens"], 2);
                        }
                    } else {
                        assert!(content_type.starts_with("text/event-stream"));
                        let payloads = events(&body);
                        if entry == "openai_chat" {
                            let field = if case == "refusal" {
                                "refusal"
                            } else {
                                "content"
                            };
                            let text = payloads
                                .iter()
                                .filter_map(|event| event["choices"][0]["delta"][field].as_str())
                                .collect::<String>();
                            assert_eq!(text, expected_text, "{entry}/{case}: {body}");
                            assert!(payloads.iter().any(|event| event["choices"][0]
                                ["finish_reason"]
                                == expected_finish));
                            assert!(payloads
                                .iter()
                                .any(|event| event["usage"]["prompt_tokens"] == 3
                                    && event["usage"]["completion_tokens"] == 2));
                            assert!(body.contains("data: [DONE]"));
                        } else {
                            let text = payloads
                                .iter()
                                .filter_map(|event| event["delta"]["text"].as_str())
                                .collect::<String>();
                            assert_eq!(text, expected_text, "{entry}/{case}: {body}");
                            assert!(payloads
                                .iter()
                                .any(|event| event["delta"]["stop_reason"] == expected_finish));
                            assert!(payloads.iter().any(|event| event["type"] == "message_stop"));
                            assert!(payloads
                                .iter()
                                .any(|event| event["message"]["usage"]["input_tokens"] == 3));
                        }
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// 0e129d0: public conversion must not turn provider pause or exhaustion into stop.
#[tokio::test]
async fn issue0e129d0_actual_error_uses_error_chain_and_switches_provider() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for process in ["direct", "relay"] {
        let first = sse(
            "response.failed",
            &json!({"type":"response.failed","response":{"id":"failed-exact","status":"failed","error":{"code":"EXACT_UPSTREAM_CAUSE_0E129D0","message":"exact upstream failure, preserve me"},"output":[]}}),
        );
        let second = response_sse(&text_response("RECOVERED_AFTER_REAL_ERROR_0E129D0"));
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            process,
            StatusCode::OK,
            "text/event-stream",
            first.clone(),
            EntryOptions {
                attempt_bodies: vec![first, second],
                two_provider_route: true,
                ..EntryOptions::default()
            },
        )
        .await;
        let consumed = consume_response(client().post(endpoint).json(&json!({"model":"router-test","input":"recover actual provider error","stream":true})).send().await).await;
        let attempts: Vec<_> = std::iter::from_fn(|| captures.try_recv().ok()).collect();
        stop_entry(handle, shutdown).await;
        assert_eq!(attempts.len(), 2, "{process}: {consumed:?}");
        assert_eq!(attempts[0]["model"], "wire-test");
        assert_eq!(attempts[1]["model"], "wire-independent");
        assert!(consumed.transport_error.is_none(), "{consumed:?}");
        assert!(
            consumed.body.contains("RECOVERED_AFTER_REAL_ERROR_0E129D0"),
            "{consumed:?}"
        );
        assert!(
            !consumed.body.contains("EXACT_UPSTREAM_CAUSE_0E129D0"),
            "error payload must remain internal"
        );
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(KEY_ENV);
}

/// 0e129d0 non-stop business terminals remain business responses.
#[tokio::test]
async fn issue0e129d0_anthropic_nonstop_reason_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for reason in [
        "pause_turn",
        "model_context_window_exceeded",
        "stop_sequence",
    ] {
        for streaming in [false, true] {
            eprintln!("0e129d0 public case reason={reason} streaming={streaming}");
            let mut response = json!({"id":"terminal-fidelity","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"NATIVE_OK"}],"stop_reason":reason,"usage":{"input_tokens":3,"output_tokens":2}});
            if reason == "stop_sequence" {
                response["stop_sequence"] = json!("END");
            }
            let wire = if streaming {
                sse(
                    "message_start",
                    &json!({"type":"message_start","message":{"id":"terminal-fidelity","type":"message","role":"assistant","model":"wire-test","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}),
                ) + &sse(
                    "content_block_start",
                    &json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"NATIVE_OK"}}),
                ) + &sse(
                    "content_block_stop",
                    &json!({"type":"content_block_stop","index":0}),
                ) + &sse(
                    "message_delta",
                    &json!({"type":"message_delta","delta":{"stop_reason":reason,"stop_sequence":response["stop_sequence"]},"usage":{"output_tokens":2}}),
                ) + &sse("message_stop", &json!({"type":"message_stop"}))
            } else {
                response.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "anthropic",
                "chat",
                StatusCode::OK,
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                wire,
            )
            .await;
            let result = client().post(endpoint.replace("/v1/responses", "/v1/chat/completions"))
                .json(&json!({"model":"test.test","messages":[{"role":"user","content":"terminal fidelity"}],"stream":streaming})).send().await;
            let (media, body) = successful_transfer(result).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            if media.starts_with("application/json") {
                let payload: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(
                    payload["choices"][0]["message"]["content"], "NATIVE_OK",
                    "{body}"
                );
                assert_eq!(payload["choices"][0]["finish_reason"], reason, "{body}");
            } else {
                let text: String = events(&body)
                    .iter()
                    .filter_map(|event| event["choices"][0]["delta"]["content"].as_str())
                    .collect();
                assert_eq!(text, "NATIVE_OK", "{body}");
                assert!(
                    events(&body)
                        .iter()
                        .any(|event| event["choices"][0]["finish_reason"] == reason),
                    "{reason}: {body}"
                );
                assert!(
                    !events(&body)
                        .iter()
                        .any(|event| event["choices"][0]["finish_reason"] == "stop"),
                    "{body}"
                );
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// 0e129d0: a genuine original Responses normal completion is a valid
/// protocol equivalent that must project to the Chat normal terminal in
/// JSON and SSE. An explicit non-stop nested reason still takes precedence.
#[tokio::test]
async fn issue0e129d0_responses_completed_projects_chat_terminal() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for streaming in [false, true] {
        let mut normal = text_response("COMPLETED_NORMAL_0E129D0");
        normal["usage"] = json!({"input_tokens":3,"output_tokens":2,"total_tokens":5});
        let upstream = if streaming {
            response_sse(&normal)
        } else {
            normal.to_string()
        };
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
            upstream,
        )
        .await;
        let chat_endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
        let request = if streaming {
            json!({"model":"test.test","messages":[{"role":"user","content":"completed terminal"}],"stream":true,"stream_options":{"include_usage":true}})
        } else {
            json!({"model":"test.test","messages":[{"role":"user","content":"completed terminal"}],"stream":false})
        };
        let (content_type, body) =
            successful_transfer(client().post(chat_endpoint).json(&request).send().await).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        if streaming {
            assert!(content_type.starts_with("text/event-stream"));
            let payloads = events(&body);
            assert_eq!(
                payloads
                    .iter()
                    .filter_map(|event| event["choices"][0]["delta"]["content"].as_str())
                    .collect::<String>(),
                "COMPLETED_NORMAL_0E129D0",
                "{body}"
            );
            assert!(payloads
                .iter()
                .any(|event| event["choices"][0]["finish_reason"] == "stop"));
            assert!(body.contains("data: [DONE]"));
        } else {
            assert!(content_type.starts_with("application/json"));
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                payload["choices"][0]["message"]["content"],
                "COMPLETED_NORMAL_0E129D0"
            );
            assert_eq!(payload["choices"][0]["finish_reason"], "stop");
        }
    }

    // A completed envelope carrying a nested explicit non-stop reason must
    // never become stop. Length and content_filter keep their mapping.
    for (reason, expected) in [
        ("max_output_tokens", "length"),
        ("content_filter", "content_filter"),
        ("opaque_reason", "opaque_reason"),
    ] {
        for streaming in [false, true] {
            let mut nested = text_response("NESTED_REASON_0E129D0");
            nested["status"] = json!("completed");
            nested["incomplete_details"] = json!({"reason":reason});
            let upstream = if streaming {
                response_sse(&nested)
            } else {
                nested.to_string()
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry(
                "responses",
                "chat",
                StatusCode::OK,
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                upstream,
            )
            .await;
            let chat_endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
            let request = if streaming {
                json!({"model":"test.test","messages":[{"role":"user","content":"nested reason"}],"stream":true})
            } else {
                json!({"model":"test.test","messages":[{"role":"user","content":"nested reason"}],"stream":false})
            };
            let (content_type, body) =
                successful_transfer(client().post(chat_endpoint).json(&request).send().await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            if streaming {
                assert!(
                    content_type.starts_with("text/event-stream"),
                    "{content_type}"
                );
                let payloads = events(&body);
                let terminal = payloads
                    .iter()
                    .find(|event| event["choices"][0]["finish_reason"].is_string())
                    .unwrap_or_else(|| panic!("missing terminal chunk: {body}"));
                assert_eq!(terminal["choices"][0]["finish_reason"], expected, "{body}");
                assert_ne!(
                    terminal["choices"][0]["finish_reason"], "stop",
                    "nested reason must not become stop: {body}"
                );
            } else {
                assert!(
                    content_type.starts_with("application/json"),
                    "{content_type}"
                );
                let payload: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(payload["choices"][0]["finish_reason"], expected, "{body}");
                assert_ne!(
                    payload["choices"][0]["finish_reason"], "stop",
                    "nested reason must not become stop: {body}"
                );
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_content_filter_and_refusal_keep_representable_semantics() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let pure_refusal_sse = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","refusal":"provider declined this request"},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        )
    );
    let mixed_refusal_sse = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"content":"partial text","refusal":"provider declined this request"},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_control","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        ),
    );
    let refusal_json = json!({"id":"chat_control","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"partial text","refusal":"provider declined this request"},"finish_reason":"content_filter"}]}).to_string();
    for (content_type, upstream, expected_text) in [
        ("text/event-stream", pure_refusal_sse, None),
        ("text/event-stream", mixed_refusal_sse, Some("partial text")),
        ("application/json", refusal_json, Some("partial text")),
    ] {
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "openai_chat",
            "chat",
            StatusCode::OK,
            content_type,
            upstream,
        )
        .await;
        let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let payloads = events(&body);
        let terminal = payloads
            .iter()
            .find(|event| event["type"] == "response.incomplete")
            .expect("content_filter maps to incomplete");
        assert_eq!(
            terminal["response"]["incomplete_details"]["reason"],
            "content_filter"
        );
        assert!(
            terminal["response"]["output"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["type"] == "refusal"
                        && part["refusal"] == "provider declined this request"))),
            "retain refusal: {body}"
        );
        assert!(!payloads
            .iter()
            .any(|event| event["type"] == "response.completed"));
        if let Some(expected_text) = expected_text {
            assert!(
                terminal["response"]["output"]
                    .to_string()
                    .contains(expected_text),
                "co-located text must survive: {body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_refusal_details_survive_json_and_sse_public_entries() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    // Opaque provider data covers the full JSON domain, independently of the
    // terminal reason. These cases traverse normalization and projection.
    for (stop_reason, status) in [
        ("refusal", "incomplete"),
        ("end_turn", "completed"),
        ("max_tokens", "incomplete"),
        ("stop_sequence", "completed"),
        ("tool_use", "completed"),
        ("pause_turn", "in_progress"),
    ] {
        for details in [
            json!({"type":"refusal","category":"cyber", "explanation":" exact policy\n", "vendor":{"items":[1,"opaque"]}}),
            json!(" exact opaque\n string "),
            json!([1, null, {"vendor":true}]),
            json!(42.5),
            json!(false),
            Value::Null,
        ] {
            for text in ["", " partial text "] {
                let mut content = if text.is_empty() {
                    json!([])
                } else {
                    json!([{"type":"text","text":text}])
                };
                if stop_reason == "tool_use" {
                    content.as_array_mut().unwrap().push(json!({"type":"tool_use","id":"call_details","name":"lookup","input":{"q":" exact input "}}));
                }
                let native = json!({"id":"msg_details","type":"message","role":"assistant",
                "model":"wire-test","content":content,"stop_reason":stop_reason,
                "stop_details":details,"usage":{"input_tokens":7,"output_tokens":2}});
                let mut native = native;
                if stop_reason == "stop_sequence" {
                    native["stop_sequence"] = json!(" exact stop ");
                }
                let mut upstream_sse = sse(
                    "message_start",
                    &json!({"type":"message_start",
                "message":{"id":"msg_details","type":"message","role":"assistant",
                    "model":"wire-test","content":[],"stop_reason":null,
                    "stop_details":null,"usage":{"input_tokens":7,"output_tokens":0}}}),
                );
                if !text.is_empty() {
                    upstream_sse.push_str(&sse(
                        "content_block_start",
                        &json!({"type":"content_block_start",
                    "index":0,"content_block":{"type":"text","text":""}}),
                    ));
                    upstream_sse.push_str(&sse(
                        "content_block_delta",
                        &json!({"type":"content_block_delta",
                    "index":0,"delta":{"type":"text_delta","text":text}}),
                    ));
                    upstream_sse.push_str(&sse(
                        "content_block_stop",
                        &json!({"type":"content_block_stop","index":0}),
                    ));
                }
                let mut delta = json!({"stop_reason":stop_reason,"stop_details":details});
                if stop_reason == "tool_use" {
                    let index = usize::from(!text.is_empty());
                    upstream_sse.push_str(&sse("content_block_start", &json!({"type":"content_block_start","index":index,"content_block":content[index]})));
                    upstream_sse.push_str(&sse(
                        "content_block_stop",
                        &json!({"type":"content_block_stop","index":index}),
                    ));
                }
                if stop_reason == "stop_sequence" {
                    delta["stop_sequence"] = json!(" exact stop ");
                }
                upstream_sse.push_str(&sse(
                    "message_delta",
                    &json!({"type":"message_delta",
                "delta":delta,"usage":{"output_tokens":2}}),
                ));
                upstream_sse.push_str(&sse("message_stop", &json!({"type":"message_stop"})));
                for streaming in [false, true] {
                    let media: &[&str] = if streaming {
                        &["application/json", "text/event-stream"]
                    } else {
                        &["application/json"]
                    };
                    for &upstream_type in media {
                        for entry in ["responses", "anthropic"] {
                            let upstream = if upstream_type == "application/json" {
                                native.to_string()
                            } else {
                                upstream_sse.clone()
                            };
                            let (endpoint, handle, mut captures, shutdown) = start_entry(
                                "anthropic",
                                "chat",
                                StatusCode::OK,
                                upstream_type,
                                upstream,
                            )
                            .await;
                            let request = if entry == "anthropic" {
                                json!({"model":"test.test","max_tokens":128,"stream":streaming,
                                "messages":[{"role":"user","content":"preserve refusal details"}]})
                            } else {
                                json!({"model":"test.test","stream":streaming,"input":"preserve refusal details"})
                            };
                            let endpoint = if entry == "anthropic" {
                                endpoint.replace("/v1/responses", "/v1/messages")
                            } else {
                                endpoint
                            };
                            // v8 user contract: only a genuinely empty attempt
                            // becomes the internal 502. `refusal` (Anthropic
                            // `stop_reason=refusal` -> Responses
                            // `incomplete_details.reason=content_filter`) and
                            // `tool_use` (a real tool-call block) carry legal
                            // business content and keep their original fidelity
                            // assertions below. The remaining terminal reasons
                            // with an empty content array carry no business
                            // content at all, so they are the empty-attempt
                            // branch: internal 502, transport abort, no normal
                            // completion and no client error payload.
                            let empty_attempt = text.is_empty()
                                && details.get("type").and_then(Value::as_str) != Some("refusal")
                                && matches!(
                                    stop_reason,
                                    "end_turn" | "max_tokens" | "stop_sequence" | "pause_turn"
                                );
                            if empty_attempt {
                                assert_incomplete_transport(
                                    client().post(endpoint).json(&request).send().await,
                                )
                                .await;
                                stop_entry(handle, shutdown).await;
                                assert_one_attempt(&mut captures, "wire-test").await;
                                continue;
                            }
                            let (content_type, body) = successful_transfer(
                                client().post(endpoint).json(&request).send().await,
                            )
                            .await;
                            stop_entry(handle, shutdown).await;
                            assert_one_attempt(&mut captures, "wire-test").await;
                            if content_type.contains("application/json") {
                                let value: Value = serde_json::from_str(&body).unwrap();
                                assert_eq!(
                                    value.get("stop_details"),
                                    Some(&details),
                                    "{entry}/{upstream_type}: {body}"
                                );
                                if entry == "anthropic" {
                                    assert_eq!(value, native);
                                } else {
                                    assert_eq!(value["status"], status);
                                    if !text.is_empty() {
                                        assert_eq!(value["output"][0]["content"][0]["text"], text);
                                    }
                                }
                            } else {
                                let payloads = events(&body);
                                let terminal = payloads
                                    .iter()
                                    .rev()
                                    .find(|event| {
                                        event["type"]
                                            == if entry == "anthropic" {
                                                "message_delta"
                                            } else {
                                                match status {
                                                    "incomplete" => "response.incomplete",
                                                    "in_progress" => "response.in_progress",
                                                    _ => "response.completed",
                                                }
                                            }
                                    })
                                    .expect("provider output must reach its client terminal");
                                let value = if entry == "anthropic" {
                                    &terminal["delta"]
                                } else {
                                    &terminal["response"]
                                };
                                assert_eq!(
                                    value.get("stop_details"),
                                    Some(&details),
                                    "{entry}/{upstream_type}: {body}"
                                );
                                if entry == "anthropic" {
                                    assert_eq!(value["stop_reason"], stop_reason);
                                    assert!(payloads
                                        .iter()
                                        .any(|event| event["type"] == "message_stop"));
                                } else {
                                    assert_eq!(value["status"], status);
                                    if !text.is_empty() {
                                        assert_eq!(
                                            value["output"][0]["content"][0]["text"], text,
                                            "{body}"
                                        );
                                    }
                                    if status == "in_progress" {
                                        assert!(
                                            !payloads
                                                .iter()
                                                .any(|event| event["type"] == "response.completed"),
                                            "pause_turn must remain in_progress: {body}"
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_refusal_remains_provider_output() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream = [
        sse("message_start", &json!({"type":"message_start","message":{"id":"msg_refusal","type":"message","role":"assistant","model":"wire-test","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}})),
        sse("content_block_start", &json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}})),
        sse("content_block_delta", &json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"provider declined this request"}})),
        sse("content_block_stop", &json!({"type":"content_block_stop","index":0})),
        sse("message_delta", &json!({"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":5}})),
        sse("message_stop", &json!({"type":"message_stop"})),
    ].concat();
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "anthropic",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let body = successful_body(post_request(&client(), &endpoint, "test.test").await).await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    let payloads = events(&body);
    let terminal = payloads
        .iter()
        .find(|event| event["type"] == "response.incomplete")
        .expect("Anthropic refusal maps to incomplete/content_filter");
    assert!(
        terminal["response"]
            .to_string()
            .contains("provider declined this request"),
        "retain refusal content: {body}"
    );
    assert_eq!(
        terminal["response"]["incomplete_details"]["reason"],
        "content_filter"
    );
    assert!(
        !payloads
            .iter()
            .any(|event| event["type"] == "response.completed"),
        "refusal must not become a completed turn: {body}"
    );
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_incomplete_tools_preserve_terminal_reason_and_full_calls() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for reason in [None, Some("content_filter"), Some("max_output_tokens")] {
        for mode in 0..4 {
            let mut expected = text_response(" exact partial text \n");
            let tool = json!({"type":"function_call","call_id":"call_original","name":"lookup",
                "arguments":"{\"q\":\" exact input \\n\"}"});
            expected["output"]
                .as_array_mut()
                .unwrap()
                .push(tool.clone());
            expected["usage"] = json!({"input_tokens":7,"output_tokens":3,"total_tokens":10});
            if let Some(reason) = reason {
                expected["status"] = json!("incomplete");
                expected["incomplete_details"] = json!({"reason":reason});
            }
            let (content_type, upstream) = if mode < 2 {
                ("application/json", expected.to_string())
            } else {
                let mut upstream = String::new();
                if mode == 3 {
                    for (index, item) in expected["output"].as_array().unwrap().iter().enumerate() {
                        upstream.push_str(&sse("response.output_item.done",
                            &json!({"type":"response.output_item.done","output_index":index,"item":item})));
                    }
                }
                upstream.push_str(&response_sse(&expected));
                ("text/event-stream", upstream)
            };
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("responses", "chat", StatusCode::OK, content_type, upstream).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let response = client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,
                "messages":[{"role":"user","content":"incomplete tool terminal"}],"stream":mode != 0,
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}]})).send().await;
            let response = response.expect("successful upstream must reach Anthropic client");
            assert_eq!(response.status(), StatusCode::OK);
            let media = response.headers()["content-type"]
                .to_str()
                .unwrap()
                .to_owned();
            let body = response
                .text()
                .await
                .expect("Anthropic response must complete");
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let expected_reason = match reason {
                Some("content_filter") => "refusal",
                Some("max_output_tokens") => "max_tokens",
                _ => "tool_use",
            };
            let (content, actual_reason) = if media.starts_with("application/json") {
                let value: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["usage"]["input_tokens"], 7);
                assert_eq!(value["usage"]["output_tokens"], 3);
                (
                    value["content"].as_array().unwrap().clone(),
                    value["stop_reason"].clone(),
                )
            } else {
                let frames = events(&body);
                let terminal = frames
                    .iter()
                    .find(|frame| frame["type"] == "message_delta")
                    .unwrap();
                assert_eq!(terminal["usage"]["output_tokens"], 3);
                assert_eq!(
                    frames
                        .iter()
                        .filter(|frame| frame["type"] == "message_stop")
                        .count(),
                    1
                );
                (
                    anthropic_sse_content_blocks(&body),
                    terminal["delta"]["stop_reason"].clone(),
                )
            };
            assert_eq!(
                actual_reason, expected_reason,
                "reason={reason:?} mode={mode}: {body}"
            );
            let tools: Vec<_> = content
                .iter()
                .filter(|part| part["type"] == "tool_use")
                .collect();
            assert_eq!(tools.len(), 1, "{body}");
            assert_eq!(tools[0]["id"], tool["call_id"], "{body}");
            assert_eq!(tools[0]["name"], tool["name"], "{body}");
            assert_eq!(tools[0]["input"], json!({"q":" exact input \n"}), "{body}");
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_incomplete_tools_preserve_terminal_reason_and_full_calls() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for reason in [None, Some("content_filter"), Some("max_output_tokens")] {
        for tool_count in [1, 2] {
            for mode in 0..4 {
                let mut expected = text_response(" exact partial text \n");
                let calls: Vec<_> = (0..tool_count)
                    .map(|index| json!({"type":"function_call","call_id":format!("call_{index}"),
                        "name":"lookup","arguments":if index == 0 {"{\"q\":\"first\"}"} else {"{\"q\":\"partial"}}))
                    .collect();
                expected["output"]
                    .as_array_mut()
                    .unwrap()
                    .extend(calls.clone());
                expected["usage"] = json!({"input_tokens":7,"output_tokens":3,"total_tokens":10});
                if let Some(reason) = reason {
                    expected["status"] = json!("incomplete");
                    expected["incomplete_details"] = json!({"reason":reason});
                }
                let (content_type, upstream) = if mode < 2 {
                    ("application/json", expected.to_string())
                } else {
                    let mut upstream = String::new();
                    if mode == 3 {
                        for (index, item) in
                            expected["output"].as_array().unwrap().iter().enumerate()
                        {
                            upstream.push_str(&sse("response.output_item.done",
                                &json!({"type":"response.output_item.done","output_index":index,"item":item})));
                        }
                    }
                    upstream.push_str(&response_sse(&expected));
                    ("text/event-stream", upstream)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("responses", "chat", StatusCode::OK, content_type, upstream).await;
                let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
                let response = client().post(&endpoint).json(&json!({"model":"test.test",
                    "messages":[{"role":"user","content":"incomplete tool terminal"}],"stream":mode != 0,
                    "stream_options":{"include_usage":true},"tools":[{"type":"function",
                    "function":{"name":"lookup","parameters":{"type":"object"}}}]})).send().await;
                let response = response.expect("successful upstream must reach Chat client");
                assert_eq!(response.status(), StatusCode::OK);
                let media = response.headers()["content-type"]
                    .to_str()
                    .unwrap()
                    .to_owned();
                let body = response.text().await.unwrap_or_else(|error| panic!("Chat response must complete: reason={reason:?} tool_count={tool_count} mode={mode}: {error}"));
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
                let finish_reason = match reason {
                    Some("content_filter") => "content_filter",
                    Some("max_output_tokens") => "length",
                    _ => "tool_calls",
                };
                let (actual_calls, text) = if media.starts_with("application/json") {
                    let value: Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(
                        value["choices"][0]["finish_reason"], finish_reason,
                        "reason={reason:?} tools={tool_count} mode={mode}: {body}"
                    );
                    assert_eq!(value["usage"]["total_tokens"], 10);
                    (
                        value["choices"][0]["message"]["tool_calls"]
                            .as_array()
                            .unwrap()
                            .clone(),
                        value["choices"][0]["message"]["content"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    )
                } else {
                    let frames = events(&body);
                    let terminals: Vec<_> = frames
                        .iter()
                        .filter_map(|frame| frame["choices"][0]["finish_reason"].as_str())
                        .collect();
                    assert_eq!(
                        terminals,
                        vec![finish_reason],
                        "reason={reason:?} tools={tool_count} mode={mode}: {body}"
                    );
                    assert!(
                        frames
                            .iter()
                            .any(|frame| frame["usage"]["total_tokens"] == 10),
                        "{body}"
                    );
                    assert!(body.trim_end().ends_with("data: [DONE]"), "{body}");
                    (
                        frames
                            .iter()
                            .filter_map(|frame| {
                                frame["choices"][0]["delta"]["tool_calls"].as_array()
                            })
                            .flatten()
                            .cloned()
                            .collect(),
                        frames
                            .iter()
                            .filter_map(|frame| frame["choices"][0]["delta"]["content"].as_str())
                            .collect::<String>(),
                    )
                };
                assert_eq!(text, " exact partial text \n", "{body}");
                assert_eq!(actual_calls.len(), calls.len(), "{body}");
                for (actual, original) in actual_calls.iter().zip(&calls) {
                    assert_eq!(actual["id"], original["call_id"], "{body}");
                    assert_eq!(actual["function"]["name"], original["name"], "{body}");
                    assert_eq!(
                        actual["function"]["arguments"], original["arguments"],
                        "{body}"
                    );
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

fn chat_tool_fixture(arguments: Value, finish_reason: &str, mode: usize) -> (&'static str, String) {
    let tool = json!({"id":"call_original","type":"function","function":{"name":"lookup","arguments":arguments}});
    let message =
        json!({"role":"assistant","content":" exact partial text \n","tool_calls":[tool]});
    if mode < 2 {
        return (
            "application/json",
            json!({"id":"chatcmpl-original","object":"chat.completion","model":"wire-test",
            "choices":[{"index":0,"message":message,"finish_reason":finish_reason}],
            "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
            .to_string(),
        );
    }
    let mut delta = message;
    delta["tool_calls"][0]["index"] = json!(0);
    let (first, tail) = if mode == 3 && delta["tool_calls"][0]["function"]["arguments"].is_string()
    {
        let raw = delta["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .to_owned();
        let cut = raw.len() / 2;
        delta["tool_calls"][0]["function"]["arguments"] = json!(&raw[..cut]);
        (
            delta,
            json!({"tool_calls":[{"index":0,"function":{"arguments":&raw[cut..]}}]}),
        )
    } else {
        (delta, json!({}))
    };
    let mut body = String::new();
    for (delta, reason) in [(first, Value::Null), (tail, json!(finish_reason))] {
        body.push_str(&format!(
            "data: {}\n\n",
            json!({"id":"chatcmpl-original","object":"chat.completion.chunk","model":"wire-test",
            "choices":[{"index":0,"delta":delta,"finish_reason":reason}],
            "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
        ));
    }
    body.push_str("data: [DONE]\n\n");
    ("text/event-stream", body)
}

#[tokio::test]
async fn responses_structured_tool_values_survive_chat_and_responses_clients() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let input = json!({"left":2,"right":3,"q":" exact input \n","nested":{"retain":[1,2]}});
    let domain = [
        Some(input.clone()),
        Some(json!(input.to_string())),
        Some(json!("{\"q\":")),
        Some(json!("")),
        Some(json!([1,{"keep":true}])),
        Some(Value::Null),
        Some(json!(true)),
        Some(json!(7)),
        None,
    ];
    for raw in domain {
        for kind in ["function_call", "custom_tool_call"] {
            let field = if kind == "function_call" {
                "arguments"
            } else {
                "input"
            };
            for reason in [
                None,
                Some("provider_specific_reason"),
                Some("content_filter"),
                Some("max_output_tokens"),
            ] {
                for mode in 0..5 {
                    for target in ["chat", "responses"] {
                        eprintln!("R10 case kind={kind} raw={raw:?} reason={reason:?} mode={mode} target={target}");
                        let mut original = json!({"type":kind,"id":"fc_original","call_id":"call_original","name":"lookup"});
                        if let Some(raw) = &raw {
                            original[field] = raw.clone();
                        }
                        let mut expected = text_response(" exact partial text \n");
                        expected["output"]
                            .as_array_mut()
                            .unwrap()
                            .push(original.clone());
                        if let Some(reason) = reason {
                            expected["status"] = json!("incomplete");
                            expected["incomplete_details"] = json!({"reason":reason});
                        }
                        let (media, upstream) = if mode < 2 {
                            ("application/json", expected.to_string())
                        } else {
                            let mut wire = String::new();
                            if mode == 3 {
                                for (index, item) in
                                    expected["output"].as_array().unwrap().iter().enumerate()
                                {
                                    wire.push_str(&sse("response.output_item.done", &json!({"type":"response.output_item.done","output_index":index,"item":item})));
                                }
                            }
                            let mut terminal = expected.clone();
                            if mode == 4 {
                                wire.push_str(&sse("response.output_item.done", &json!({"type":"response.output_item.done","output_index":0,"item":expected["output"][0]})));
                                let mut added = original.clone();
                                added.as_object_mut().unwrap().remove(field);
                                wire.push_str(&sse("response.output_item.added", &json!({"type":"response.output_item.added","output_index":1,"item":added})));
                                let event_type = if kind == "function_call" {
                                    "response.function_call_arguments.done"
                                } else {
                                    "response.custom_tool_call_input.done"
                                };
                                let mut done = json!({"type":event_type,"item_id":"fc_original","output_index":1});
                                if let Some(raw) = &raw {
                                    done[field] = raw.clone();
                                }
                                wire.push_str(&sse(event_type, &done));
                                terminal.as_object_mut().unwrap().remove("output");
                            }
                            wire.push_str(&response_sse(&terminal));
                            ("text/event-stream", wire)
                        };
                        let (endpoint, handle, mut captures, shutdown) =
                            start_entry("responses", "chat", StatusCode::OK, media, upstream).await;
                        let endpoint = if target == "chat" {
                            endpoint.replace("/v1/responses", "/v1/chat/completions")
                        } else {
                            endpoint
                        };
                        let request = if target == "chat" {
                            json!({"model":"test.test","messages":[{"role":"user","content":"complete original input"}],"stream":mode != 0,
                                "stream_options":{"include_usage":true},"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]})
                        } else {
                            json!({"model":"test.test","input":"complete original input","stream":mode != 0,"tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]})
                        };
                        let (media, body) = successful_transfer(
                            client().post(&endpoint).json(&request).send().await,
                        )
                        .await;
                        assert_one_attempt(&mut captures, "wire-test").await;
                        if target == "responses" {
                            let returned = if media.starts_with("application/json") {
                                serde_json::from_str::<Value>(&body).unwrap()
                            } else {
                                events(&body)
                                    .into_iter()
                                    .filter_map(|event| event.get("response").cloned())
                                    .last()
                                    .expect("complete terminal response")
                            };
                            let actual = returned["output"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|item| item["type"] == kind)
                                .unwrap();
                            match (original.get(field), actual.get(field)) {
                                (Some(original), Some(Value::String(actual)))
                                    if !original.is_string() && kind == "function_call" =>
                                {
                                    assert_eq!(
                                        serde_json::from_str::<Value>(actual).unwrap(),
                                        *original,
                                        "mode={mode}: {body}"
                                    );
                                }
                                _ => assert_eq!(
                                    actual.get(field),
                                    original.get(field),
                                    "kind={kind} raw={raw:?} reason={reason:?} mode={mode}: {body}"
                                ),
                            }
                        } else {
                            let calls: Vec<Value> = if media.starts_with("application/json") {
                                let value: Value = serde_json::from_str(&body).unwrap();
                                value["choices"][0]["message"]["tool_calls"]
                                    .as_array()
                                    .unwrap()
                                    .clone()
                            } else {
                                events(&body)
                                    .iter()
                                    .filter_map(|event| {
                                        event["choices"][0]["delta"]["tool_calls"].as_array()
                                    })
                                    .flatten()
                                    .cloned()
                                    .collect()
                            };
                            assert_eq!(calls.len(), 1, "{body}");
                            let call = &calls[0];
                            assert_eq!(call["id"], "call_original");
                            assert_eq!(call["function"]["name"], "lookup");
                            let serialized = raw.as_ref().map(|value| {
                                if kind == "custom_tool_call" {
                                    json!({"input":value}).to_string()
                                } else {
                                    value
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| value.to_string())
                                }
                            });
                            if kind == "custom_tool_call" {
                                assert_eq!(
                                    call["routecodex_chat_extension"]["responses_tool_call_type"],
                                    "custom_tool_call",
                                    "{body}"
                                );
                            }
                            match &serialized {
                                Some(serialized) => assert_eq!(call["function"]["arguments"], *serialized, "kind={kind} raw={raw:?} reason={reason:?} mode={mode}: {body}"),
                                None => assert!(call["function"].get("arguments").is_none(), "missing original parameters must stay absent: kind={kind} mode={mode}: {body}"),
                            }
                            if kind == "function_call"
                                && (raw.as_ref() == Some(&input)
                                    || raw.as_ref() == Some(&json!(input.to_string())))
                            {
                                let execution = std::process::Command::new("node").args(["-e","const a=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({sum:a.left+a.right,q:a.q,nested:a.nested}));",serialized.as_deref().expect("complete original parameters")]).output().unwrap();
                                assert!(execution.status.success());
                                let output = String::from_utf8(execution.stdout).unwrap();
                                assert_eq!(
                                    serde_json::from_str::<Value>(&output).unwrap(),
                                    json!({"sum":5,"q":" exact input \n","nested":{"retain":[1,2]}})
                                );
                                let mut followup = request.clone();
                                followup["messages"] = json!([{"role":"user","content":"complete original input"},{"role":"assistant","tool_calls":calls},
                                    {"role":"tool","tool_call_id":"call_original","content":output}]);
                                let (_, completed) = successful_transfer(
                                    client().post(&endpoint).json(&followup).send().await,
                                )
                                .await;
                                assert!(
                                    completed.contains("mixed roundtrip complete"),
                                    "{completed}"
                                );
                                let wire = captures
                                    .recv()
                                    .await
                                    .expect("actual client result reaches Responses provider");
                                let result = wire["input"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .find(|item| item["type"] == "function_call_output")
                                    .unwrap();
                                assert_eq!(result["call_id"], "call_original");
                                assert_eq!(result["output"], output);
                                assert!(matches!(
                                    captures.try_recv(),
                                    Err(mpsc::error::TryRecvError::Empty)
                                ));
                            }
                        }
                        stop_entry(handle, shutdown).await;
                    }
                }
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_chat_tools_preserve_filter_and_length_terminals() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (finish, expected) in [
        ("tool_calls", "tool_use"),
        ("content_filter", "refusal"),
        ("length", "max_tokens"),
        ("max_tokens", "max_tokens"),
        ("max_output_tokens", "max_tokens"),
    ] {
        for mode in 0..4 {
            let (media, upstream) =
                chat_tool_fixture(json!("{\"q\":\" exact input \\n\"}"), finish, mode);
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
            let response = client()
                .post(endpoint.replace("/v1/responses", "/v1/messages"))
                .json(&json!({"model":"test.test","max_tokens":128,
                "messages":[{"role":"user","content":"chat tool terminal"}],"stream":mode != 0,
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}]}))
                .send()
                .await;
            let (media, body) = successful_transfer(response).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let (reason, content) = if media.starts_with("application/json") {
                let value: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["usage"]["input_tokens"], 7);
                assert_eq!(value["usage"]["output_tokens"], 3);
                (
                    value["stop_reason"].clone(),
                    value["content"].as_array().unwrap().clone(),
                )
            } else {
                let frames = events(&body);
                assert_eq!(
                    frames
                        .iter()
                        .filter(|f| f["type"] == "message_stop")
                        .count(),
                    1
                );
                let terminal = frames
                    .iter()
                    .find(|f| f["type"] == "message_delta")
                    .unwrap();
                assert_eq!(terminal["usage"]["output_tokens"], 3);
                (terminal["delta"]["stop_reason"].clone(), {
                    let mut content = anthropic_sse_content_blocks(&body);
                    content[0]["text"] = json!(frames
                        .iter()
                        .filter_map(|f| f["delta"]["text"].as_str())
                        .collect::<String>());
                    content
                })
            };
            assert_eq!(reason, expected, "finish={finish} mode={mode}: {body}");
            assert_eq!(content[0]["text"], " exact partial text \n", "{body}");
            assert_eq!(
                content[1],
                json!({"type":"tool_use","id":"call_original","name":"lookup","input":{"q":" exact input \n"}}),
                "{body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_provider_missing_arguments_stay_absent_at_client_boundary() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for provider_stream in [false, true] {
        for target in ["responses", "chat"] {
            for client_stream in [false, true] {
                if provider_stream && !client_stream {
                    continue;
                }
                eprintln!("R12 Chat missing provider_stream={provider_stream} target={target} client_stream={client_stream}");
                let call =
                    json!({"id":"call_original","type":"function","function":{"name":"lookup"}});
                let (media, wire) = if provider_stream {
                    (
                        "text/event-stream",
                        format!(
                            "{}{}data: [DONE]\n\n",
                            sse(
                                "message",
                                &json!({"id":"chat_missing","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_original","type":"function","function":{"name":"lookup"}}]},"finish_reason":null}]})
                            ),
                            sse(
                                "message",
                                &json!({"id":"chat_missing","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
                            )
                        ),
                    )
                } else {
                    ("application/json", json!({"id":"chat_missing","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","tool_calls":[call]},"finish_reason":"tool_calls"}]}).to_string())
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("openai_chat", "chat", StatusCode::OK, media, wire).await;
                let response = if target == "chat" {
                    client().post(endpoint.replace("/v1/responses", "/v1/chat/completions")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"missing parameters"}],"stream":client_stream})).send().await
                } else {
                    client().post(&endpoint).json(&json!({"model":"test.test","input":"missing parameters","stream":client_stream})).send().await
                };
                let (media, body) = successful_transfer(response).await;
                if target == "responses" {
                    let returned = if media.starts_with("application/json") {
                        serde_json::from_str::<Value>(&body).unwrap()
                    } else {
                        body.lines()
                            .filter_map(|line| line.strip_prefix("data:"))
                            .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                            .filter_map(|v| v.get("response").cloned())
                            .last()
                            .unwrap()
                    };
                    let actual = returned["output"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|v| v["type"] == "function_call")
                        .unwrap();
                    assert!(
                        actual.get("arguments").is_none(),
                        "provider_stream={provider_stream} client_stream={client_stream}: {body}"
                    );
                    assert_eq!(actual["call_id"], "call_original");
                } else if media.starts_with("application/json") {
                    let returned: Value = serde_json::from_str(&body).unwrap();
                    assert!(
                        returned["choices"][0]["message"]["tool_calls"][0]["function"]
                            .get("arguments")
                            .is_none(),
                        "{body}"
                    );
                } else {
                    for frame in body
                        .lines()
                        .filter_map(|line| line.strip_prefix("data:"))
                        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                    {
                        if let Some(calls) = frame["choices"][0]["delta"]["tool_calls"].as_array() {
                            for actual in calls {
                                assert!(actual["function"].get("arguments").is_none(), "{body}");
                            }
                        }
                    }
                }
                stop_entry(handle, shutdown).await;
                assert_one_attempt(&mut captures, "wire-test").await;
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn unrepresentable_anthropic_tools_do_not_cool_a_healthy_provider_identity() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for kind in ["openai_chat", "responses", "responses_absent_custom"] {
        for mode in 0..4 {
            let (media, upstream) = if kind == "openai_chat" {
                chat_tool_fixture(json!("{\"q\":"), "tool_calls", mode)
            } else {
                let mut value = json!({"id":"resp-invalid","object":"response","status":"completed","model":"wire-test","output":[{"type":"function_call","id":"fc-invalid","call_id":"call_original","name":"lookup","arguments":"{\"q\":"}]});
                if kind == "responses_absent_custom" {
                    value["output"][0] = json!({"type":"custom_tool_call","id":"fc-invalid","call_id":"call_original","name":"lookup"});
                }
                if mode < 2 {
                    ("application/json", value.to_string())
                } else {
                    ("text/event-stream", response_sse(&value))
                }
            };
            let (endpoint, handle, mut captures, shutdown) = start_entry_with_health(
                if kind == "responses_absent_custom" {
                    "responses"
                } else {
                    kind
                },
                "chat",
                StatusCode::OK,
                media,
                upstream,
                true,
            )
            .await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let base = endpoint.strip_suffix("/v1/messages").unwrap();
            let preflight = json!({"model":"test.test","max_tokens":128,"messages":[{"role":"user","content":"representation-preflight"}],"stream":mode != 0});
            let (_, body) =
                successful_transfer(client().post(&endpoint).json(&preflight).send().await).await;
            assert!(body.contains("representation-valid-completion"), "{body}");
            let before: Value = client()
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(
                before["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|entry| entry["provider_id"] != "test"),
                "baseline healthy identity: {before}"
            );
            for index in 0..2 {
                let request = json!({"model":"test.test","max_tokens":128,"messages":[{"role":"user","content":format!("representation-invalid-{index}")}],"stream":mode != 0});
                assert_incomplete_transport(client().post(&endpoint).json(&request).send().await)
                    .await;
            }
            let pool: Value = client()
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(
                pool["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|entry| entry["provider_id"] != "test"),
                "local tool projection must not cool provider: kind={kind} mode={mode} pool={pool}"
            );
            let request = json!({"model":"test.test","max_tokens":128,"messages":[{"role":"user","content":"representation-valid-request"}],"stream":mode != 0});
            let (_, body) =
                successful_transfer(client().post(&endpoint).json(&request).send().await).await;
            assert!(body.contains("representation-valid-completion"), "{body}");
            stop_entry(handle, shutdown).await;
            let mut business = Vec::new();
            while let Ok(wire) = captures.try_recv() {
                if wire.to_string().contains("representation-") {
                    business.push(wire);
                }
            }
            for marker in [
                "representation-preflight",
                "representation-invalid-0",
                "representation-invalid-1",
                "representation-valid-request",
            ] {
                assert_eq!(
                    business
                        .iter()
                        .filter(|wire| wire.to_string().contains(marker))
                        .count(),
                    1,
                    "same identity reaches upstream once per request: {business:?}"
                );
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_chat_unrepresentable_arguments_never_execute_empty_input() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for raw in [
        json!("{\"q\":"),
        json!(""),
        json!("null"),
        json!("[]"),
        json!("true"),
        json!("7"),
        json!([]),
        Value::Null,
        json!(true),
        json!(7),
    ] {
        for mode in 0..4 {
            let (media, upstream) = chat_tool_fixture(raw.clone(), "tool_calls", mode);
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
            let response = client().post(endpoint.replace("/v1/responses", "/v1/messages")).json(&json!({"model":"test.test","max_tokens":128,
                "messages":[{"role":"user","content":"unrepresentable tool input"}],"stream":mode != 0,
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}]})).send().await;
            assert_incomplete_transport(response).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-test").await;
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_chat_complete_argument_objects_execute_and_follow_up_exactly() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let input = json!({"q":" exact input \n", "nested":{"retain":[1,2]}, "left":2,"right":3});
    for raw in [json!(input.to_string()), input.clone()] {
        for mode in 0..4 {
            let (media, upstream) = chat_tool_fixture(raw.clone(), "tool_calls", mode);
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let user = json!({"role":"user","content":"complete tool input"});
            let tools = json!([{"name":"lookup","input_schema":{"type":"object"}}]);
            let (media, body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,"messages":[user],"stream":mode != 0,"tools":tools})).send().await).await;
            let content: Vec<Value> = if media.starts_with("application/json") {
                let value: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["stop_reason"], "tool_use");
                value["content"].as_array().unwrap().clone()
            } else {
                anthropic_sse_content_blocks(&body)
            };
            let call = content
                .iter()
                .find(|b| b["type"] == "tool_use")
                .expect("complete original tool");
            assert_eq!(call["id"], "call_original");
            assert_eq!(call["name"], "lookup");
            assert_eq!(call["input"], input, "raw={raw} mode={mode}: {body}");
            assert_one_attempt(&mut captures, "wire-test").await;
            let execution = std::process::Command::new("node").args(["-e","const a=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify({sum:a.left+a.right,q:a.q,nested:a.nested}));",&call["input"].to_string()]).output().unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"sum":5,"q":" exact input \n","nested":{"retain":[1,2]}})
            );
            let (media, completed) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,"stream":mode != 0,"tools":tools,
                "messages":[user,{"role":"assistant","content":[call]},{"role":"user","content":[{"type":"tool_result","tool_use_id":call["id"],"content":output}]}]})).send().await).await;
            stop_entry(handle, shutdown).await;
            let wire = captures
                .recv()
                .await
                .expect("matching actual result reaches Chat provider");
            let messages = wire["messages"].as_array().unwrap();
            let original = messages
                .iter()
                .find_map(|m| m["tool_calls"].as_array())
                .unwrap();
            assert_eq!(original[0]["id"], call["id"]);
            assert_eq!(original[0]["function"]["name"], call["name"]);
            assert_eq!(
                serde_json::from_str::<Value>(
                    original[0]["function"]["arguments"].as_str().unwrap()
                )
                .unwrap(),
                input
            );
            let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
            assert_eq!(result["tool_call_id"], call["id"]);
            assert_eq!(result["content"], output);
            assert!(matches!(
                captures.try_recv(),
                Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
            ));
            if media.starts_with("application/json") {
                let final_message: Value = serde_json::from_str(&completed).unwrap();
                assert_eq!(final_message["stop_reason"], "end_turn");
                assert_eq!(
                    final_message["content"][0]["text"],
                    "chat roundtrip complete"
                );
            } else {
                let frames = events(&completed);
                assert_eq!(
                    frames
                        .iter()
                        .filter_map(|f| f["delta"]["text"].as_str())
                        .collect::<String>(),
                    "chat roundtrip complete"
                );
                assert!(frames
                    .iter()
                    .any(|f| f["delta"]["stop_reason"] == "end_turn"));
                assert_eq!(
                    frames
                        .iter()
                        .filter(|f| f["type"] == "message_stop")
                        .count(),
                    1
                );
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// c8e707e: the real Claude client discards `content_block_start.input` and
/// accumulates only `input_json_delta.partial_json`. This public-entry
/// regression proves the Anthropic SSE projection emits the complete arguments
/// as deltas, executes the received command, and keeps the paired follow-up.
#[tokio::test]
async fn c8e707e_anthropic_relay_sse_tool_input_delta_executes_and_follows_up() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let input = json!({
        "command": "printf '%s' CLAUDE_TOOL_PROBE",
        "nested": {"values": [1, 2, 3], "keep": true},
        "note": "  spaced \"quoted\" \\n "
    });
    // Cross-protocol provider with split upstream arguments exercises the Relay
    // projection into Anthropic SSE.
    let (media, upstream) = chat_tool_fixture(json!(input.to_string()), "tool_calls", 3);
    let (endpoint, handle, mut captures, shutdown) =
        start_entry("openai_chat", "chat", StatusCode::OK, media, upstream).await;
    let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
    let tools = json!([{"name":"lookup","input_schema":{"type":"object"}}]);
    let (media, body) = successful_transfer(
        client()
            .post(&endpoint)
            .json(&json!({
                "model":"test.test","max_tokens":128,"stream":true,"tools":tools,
                "messages":[{"role":"user","content":"execute the complete tool input"}]
            }))
            .send()
            .await,
    )
    .await;
    assert!(
        media.starts_with("text/event-stream"),
        "real client entry must be SSE: {body}"
    );
    let frames = events(&body);
    let start = frames
        .iter()
        .find(|frame| {
            frame["type"] == "content_block_start" && frame["content_block"]["type"] == "tool_use"
        })
        .expect("tool start block");
    let deltas = anthropic_tool_input_partial_json(&frames, start["index"].as_u64().unwrap());
    assert!(!deltas.is_empty(), "missing input_json_delta: {body}");
    assert_eq!(
        start["content_block"]["input"],
        json!({}),
        "start block must not carry the arguments: {body}"
    );
    let reconstructed: Value =
        serde_json::from_str(&deltas).expect("argument deltas must reconstruct JSON");
    assert_eq!(
        reconstructed, input,
        "exact tool input must survive the delta framing: {body}"
    );
    let blocks = anthropic_sse_content_blocks(&body);
    let call = blocks
        .iter()
        .find(|block| block["type"] == "tool_use")
        .expect("tool block");
    assert_eq!(call["id"], "call_original");
    assert_eq!(call["name"], "lookup");
    assert_eq!(
        call["input"], input,
        "delta consumer must reconstruct the exact input: {body}"
    );
    // Execute the received command only after the exact expected input assertion.
    let command = call["input"]["command"]
        .as_str()
        .expect("required command field");
    let execution = std::process::Command::new("sh")
        .args(["-c", command])
        .output()
        .unwrap();
    assert!(execution.status.success(), "{execution:?}");
    let output = String::from_utf8(execution.stdout).unwrap();
    assert_eq!(output, "CLAUDE_TOOL_PROBE");
    assert_one_attempt(&mut captures, "wire-test").await;
    // Paired same-call-ID follow-up carries the complete arguments and result.
    let (_, completed) = successful_transfer(
        client()
            .post(&endpoint)
            .json(&json!({
                "model":"test.test","max_tokens":128,"stream":true,"tools":tools,
                "messages":[
                    {"role":"user","content":"execute the complete tool input"},
                    {"role":"assistant","content":[call]},
                    {"role":"user","content":[{"type":"tool_result","tool_use_id":call["id"],"content":output}]}
                ]
            }))
            .send()
            .await,
    )
    .await;
    stop_entry(handle, shutdown).await;
    let wire = captures
        .recv()
        .await
        .expect("matching actual result reaches Chat provider");
    let messages = wire["messages"].as_array().unwrap();
    let sent = messages
        .iter()
        .find_map(|message| message["tool_calls"].as_array())
        .unwrap();
    assert_eq!(sent[0]["id"], "call_original");
    assert_eq!(sent[0]["function"]["name"], "lookup");
    assert_eq!(
        serde_json::from_str::<Value>(sent[0]["function"]["arguments"].as_str().unwrap()).unwrap(),
        input
    );
    let result = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("paired tool result");
    assert_eq!(result["tool_call_id"], "call_original");
    assert_eq!(result["content"], output);
    assert!(matches!(
        captures.try_recv(),
        Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
    ));
    assert!(completed.contains("chat roundtrip complete"), "{completed}");
    std::env::remove_var(KEY_ENV);
}

/// The installed Claude client must execute the projected Bash call itself.
#[tokio::test]
#[ignore = "manual native consumer: requires installed Claude CLI; run explicitly with --ignored"]
async fn c8e707e_native_claude_cli_executes_bash_and_follows_up() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let command = "/usr/bin/printf CLAUDE_NATIVE_TOOL_PROBE";
    let arguments = json!({"command": command}).to_string();
    let upstream = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"id":"chat-native-claude","object":"chat.completion.chunk","model":"wire-test",
            "choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{
                "index":0,"id":"call_native_claude","type":"function",
                "function":{"name":"Bash","arguments":arguments}
            }]},"finish_reason":"tool_calls"}],
            "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
    );
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "openai_chat",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let base_url = endpoint.strip_suffix("/v1/responses").unwrap();
    let config_home =
        std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join("native-claude");
    std::fs::create_dir(&config_home).unwrap();
    let mut child = tokio::process::Command::new("/Users/fanzhang/.local/bin/claude");
    child
        .args([
            "--model", "test.test", "--permission-mode", "dontAsk",
            "--allowedTools", "Bash", "--setting-sources", "",
            "--no-session-persistence", "--output-format", "stream-json", "--verbose",
            "-p", "Run /usr/bin/printf CLAUDE_NATIVE_TOOL_PROBE using Bash once, then report its actual output.",
        ])
        .env("ANTHROPIC_BASE_URL", base_url)
        .env("ANTHROPIC_API_KEY", "test-local-key")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .env_remove("CLAUDECODE")
        .env("CLAUDE_CONFIG_DIR", &config_home)
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(90), child.output()).await;
    stop_entry(handle, shutdown).await;
    std::env::remove_var(KEY_ENV);
    let output = result
        .expect("native Claude timeout")
        .expect("native Claude launch");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "native Claude failed: {stdout}\n{stderr}"
    );
    let first = captures
        .recv()
        .await
        .expect("native Claude first provider request");
    let tools = first["tools"].as_array().expect("native tool declarations");
    let bash = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "Bash")
        .expect("native Bash declaration reaches the selected provider");
    assert!(
        bash.pointer("/function/parameters/properties/command")
            .is_some(),
        "{bash}"
    );
    let followup = captures
        .recv()
        .await
        .expect("native Claude paired follow-up");
    let messages = followup["messages"].as_array().unwrap();
    let call = messages
        .iter()
        .filter_map(|message| message["tool_calls"].as_array())
        .flatten()
        .find(|call| call["id"] == "call_native_claude")
        .expect("original native call remains paired");
    assert_eq!(call["function"]["name"], "Bash");
    assert_eq!(
        serde_json::from_str::<Value>(call["function"]["arguments"].as_str().unwrap()).unwrap(),
        json!({"command": command})
    );
    let tool_result = messages
        .iter()
        .find(|message| {
            message["role"] == "tool" && message["tool_call_id"] == "call_native_claude"
        })
        .expect("the native client must return the executed tool result");
    let actual = tool_result["content"].to_string();
    assert!(
        actual.contains("CLAUDE_NATIVE_TOOL_PROBE"),
        "missing actual execution: {actual}\n{stdout}"
    );
    assert!(
        !actual.contains("InputValidationError") && !actual.contains("command is missing"),
        "{actual}"
    );
    assert!(
        stdout.contains("chat roundtrip complete"),
        "native final response: {stdout}"
    );
    assert!(
        matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ),
        "one accepted provider attempt per native turn"
    );
    eprintln!("CLAUDE_NATIVE_EXECUTION_AND_FOLLOWUP_OK");
}

fn collect_json_blocks(value: &Value, block_type: &str, out: &mut Vec<Value>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_json_blocks(item, block_type, out);
            }
        }
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some(block_type) {
                out.push(value.clone());
            }
            for child in map.values() {
                collect_json_blocks(child, block_type, out);
            }
        }
        _ => {}
    }
}

fn live_native_evidence_dir() -> std::path::PathBuf {
    std::env::var_os("CLAUDE_NATIVE_EVIDENCE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(
                "/Volumes/Intel/playground/routecodex/.worker-runs/magpie-node-flow-20261012",
            )
        })
}

fn write_live_evidence(run_dir: &std::path::Path, name: &str, bytes: &[u8]) {
    let path = run_dir.join(name);
    std::fs::write(&path, bytes).expect("required live consumer evidence");
    eprintln!("LIVE_EVIDENCE_WROTE {}", path.display());
}

/// Manual live native consumer: real Claude CLI -> isolated candidate server ->
/// this test gateway -> the currently running public RCC at 127.0.0.1:4444.
/// The gateway forwards the candidate's raw Chat body without rewriting it and
/// records the raw RCC response. Opt-in only: requires `RCC_NATIVE_LIVE=1` and
/// `RCC_NATIVE_CHAT_MODEL=<current 4444 chat route label>`.
#[tokio::test]
#[ignore = "manual real-generation native consumer"]
async fn c8e707e_native_claude_cli_live_rcc_bash_and_followup() {
    let _guard = TEST_LOCK.lock().await;
    assert_eq!(
        std::env::var("RCC_NATIVE_LIVE").ok().as_deref(),
        Some("1"),
        "manual live test: set RCC_NATIVE_LIVE=1 explicitly; absence is not PASS"
    );
    let route_model = std::env::var("RCC_NATIVE_CHAT_MODEL").unwrap_or_else(|_| {
        panic!("set RCC_NATIVE_CHAT_MODEL to the current 4444 chat route label")
    });
    let run_dir = live_native_evidence_dir();
    std::fs::create_dir_all(&run_dir).expect("live evidence run dir");
    let command = "/usr/bin/printf CLAUDE_NATIVE_TOOL_PROBE";
    let allowed_tool = format!("Bash({command})");
    let prompt = format!(
        "Call the Bash tool exactly once with the command `{command}`, then report the actual output."
    );

    std::env::set_var(KEY_ENV, "controlled-secret");
    let live_captures = Arc::new(std::sync::Mutex::new(Vec::<LiveForwardExchange>::new()));
    let live_client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();
    let (endpoint, handle, _captures, _headers, shutdown) = start_entry_configured(
        "openai_chat",
        "chat",
        StatusCode::OK,
        "application/json",
        "live upstream placeholder: the live forwarder replaces this scripted body".to_string(),
        EntryOptions {
            live_forward: Some(LiveForward {
                client: live_client,
                target: "http://127.0.0.1:4444/v1/chat/completions".to_string(),
                captures: live_captures.clone(),
            }),
            wire_model: Some(route_model.clone()),
            ..EntryOptions::default()
        },
    )
    .await;
    let base_url = endpoint
        .strip_suffix("/v1/responses")
        .expect("candidate base url")
        .to_string();

    let child_home =
        std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join("claude-native-live");
    let config_home = child_home.join("claude-config");
    std::fs::create_dir_all(&config_home).expect("fresh claude config home");

    let mut child = tokio::process::Command::new("/Users/fanzhang/.local/bin/claude");
    child
        .args([
            "--model",
            "test.test",
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            &allowed_tool,
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--output-format",
            "stream-json",
            "--verbose",
            "-p",
            &prompt,
        ])
        .env("ANTHROPIC_BASE_URL", &base_url)
        .env("ANTHROPIC_API_KEY", "test-local-key")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .env_remove("CLAUDECODE")
        .env("HOME", &child_home)
        .env("CLAUDE_CONFIG_DIR", &config_home)
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::fs::File::create(run_dir.join("claude-live-native-stdout.jsonl")).unwrap())
        .stderr(std::fs::File::create(run_dir.join("claude-live-native-stderr.log")).unwrap())
        .kill_on_drop(true);
    let mut child = child.spawn().expect("native Claude live launch");
    eprintln!("CLAUDE_LIVE_NATIVE_PID={}", child.id().unwrap());
    let status = match tokio::time::timeout(Duration::from_secs(120), child.wait()).await {
        Ok(status) => status.expect("native Claude live wait"),
        Err(_) => {
            child
                .kill()
                .await
                .expect("stop timed out owned native child");
            child
                .wait()
                .await
                .expect("reap timed out owned native child")
        }
    };
    stop_entry(handle, shutdown).await;
    std::env::remove_var(KEY_ENV);
    let output = std::process::Output {
        status,
        stdout: std::fs::read(run_dir.join("claude-live-native-stdout.jsonl")).unwrap(),
        stderr: std::fs::read(run_dir.join("claude-live-native-stderr.log")).unwrap(),
    };
    let stdout_bytes = output.stdout;
    let stderr_bytes = output.stderr;
    let stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();

    let exchanges = std::mem::take(&mut *live_captures.lock().unwrap());
    eprintln!(
        "CLAUDE_LIVE_NATIVE exit={:?} route={} candidate_forwards={} stdout_len={} stderr_len={}",
        output.status.code(),
        route_model,
        exchanges.len(),
        stdout_bytes.len(),
        stderr_bytes.len()
    );
    if !stderr.is_empty() {
        eprintln!("CLAUDE_LIVE_NATIVE_STDERR {stderr}");
    }

    assert!(
        output.status.success(),
        "native Claude live failed: exit={:?}\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status.code()
    );
    assert_eq!(
        exchanges.len(),
        2,
        "expected one accepted candidate forward per turn (2 total), got {}\nstdout:\n{stdout}\nstderr:\n{stderr}",
        exchanges.len()
    );
    let events: Vec<Value> = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect();
    assert!(
        !events.is_empty(),
        "native Claude stream-json events missing:\n{stdout}"
    );
    let mut tool_uses = Vec::new();
    collect_json_blocks(&Value::Array(events.clone()), "tool_use", &mut tool_uses);
    let bash_call = tool_uses
        .iter()
        .find(|block| block["name"] == "Bash")
        .unwrap_or_else(|| {
            panic!("real model did not emit a native Bash tool call:\nstdout:\n{stdout}\nstderr:\n{stderr}")
        });
    assert_eq!(
        bash_call["input"]["command"], command,
        "native Bash call must be the exact allowed command: {bash_call}\nstdout:\n{stdout}"
    );
    let call_id = bash_call["id"]
        .as_str()
        .expect("real generated tool call id");
    assert!(!call_id.is_empty());
    let mut tool_results = Vec::new();
    collect_json_blocks(
        &Value::Array(events.clone()),
        "tool_result",
        &mut tool_results,
    );
    let matched_result = tool_results
        .iter()
        .find(|block| block["tool_use_id"] == call_id)
        .unwrap_or_else(|| panic!("native tool_result for {call_id} missing:\nstdout:\n{stdout}"));
    let result_text = matched_result["content"].to_string();
    assert!(
        result_text.contains("CLAUDE_NATIVE_TOOL_PROBE"),
        "native Bash did not execute the fixed command: {result_text}\nstdout:\n{stdout}"
    );
    assert!(
        matched_result["is_error"] != json!(true),
        "native tool_result reports an error: {matched_result}\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        events.iter().any(|event| {
            event["type"] == "result"
                && event["subtype"] == "success"
                && event["is_error"] != json!(true)
        }),
        "native final result turn missing or failed:\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );

    let first: Value =
        serde_json::from_slice(&exchanges[0].request_body).expect("first candidate wire");
    assert_eq!(
        first["model"], route_model,
        "candidate must project the explicit route label"
    );
    let tools = first["tools"].as_array().expect("native tool declarations");
    let bash = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "Bash")
        .expect("native Bash declaration reaches the selected provider");
    assert!(
        bash.pointer("/function/parameters/properties/command")
            .is_some(),
        "{bash}"
    );
    assert_eq!(
        exchanges[0].response_status.map(|status| status.as_u16()),
        Some(200),
        "RCC must accept the first candidate forward: {:?}",
        exchanges[0].transport_error
    );

    let followup: Value =
        serde_json::from_slice(&exchanges[1].request_body).expect("follow-up candidate wire");
    let messages = followup["messages"].as_array().expect("follow-up messages");
    let paired_call = messages
        .iter()
        .filter_map(|message| message["tool_calls"].as_array())
        .flatten()
        .find(|call| call["id"] == call_id)
        .expect("native follow-up keeps the real generated call id");
    assert_eq!(paired_call["function"]["name"], "Bash");
    assert_eq!(
        serde_json::from_str::<Value>(paired_call["function"]["arguments"].as_str().unwrap())
            .unwrap(),
        bash_call["input"]
    );
    let paired_result = messages
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
        .expect("native follow-up keeps the matching tool result");
    assert!(
        paired_result["content"]
            .to_string()
            .contains("CLAUDE_NATIVE_TOOL_PROBE"),
        "paired native result must carry the real command output: {paired_result}"
    );
    assert_eq!(
        exchanges[1].response_status.map(|status| status.as_u16()),
        Some(200),
        "RCC must accept the follow-up candidate forward: {:?}",
        exchanges[1].transport_error
    );
    eprintln!("CLAUDE_LIVE_NATIVE_EXECUTION_AND_FOLLOWUP_OK call_id={call_id}");
}

/// The small test-local consumer must reject the pre-fix start-only shape and
/// mismatched fragment indexes, and must reconstruct valid split fragments.
#[test]
fn c8e707e_anthropic_tool_delta_consumer_controls() {
    let input = json!({"command":"printf '%s' CLAUDE_TOOL_PROBE","nested":{"values":[1,2,3]}});
    let full = input.to_string();
    let split_at = full.len() / 2;
    let frames = |body: &str| events(body);

    let valid = format!(
        "{}{}{}{}",
        sse(
            "content_block_start",
            &json!({"type":"content_block_start","index":0,
                "content_block":{"type":"tool_use","id":"call_original","name":"lookup","input":{}}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":0,
                "delta":{"type":"input_json_delta","partial_json":&full[..split_at]}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":0,
                "delta":{"type":"input_json_delta","partial_json":&full[split_at..]}})
        ),
        sse(
            "content_block_stop",
            &json!({"type":"content_block_stop","index":0})
        )
    );
    let blocks = anthropic_sse_content_blocks(&valid);
    assert_eq!(blocks[0]["input"], input, "split deltas must reconstruct");

    let start_only = sse(
        "content_block_start",
        &json!({"type":"content_block_start","index":0,
            "content_block":{"type":"tool_use","id":"call_original","name":"lookup","input":input.clone()}}),
    );
    let start_only_frames = frames(&start_only);
    assert!(
        anthropic_tool_input_partial_json(&start_only_frames, 0).is_empty(),
        "start-only input cannot satisfy the delta consumer"
    );

    let wrong_index = format!(
        "{}{}",
        sse(
            "content_block_start",
            &json!({"type":"content_block_start","index":0,
                "content_block":{"type":"tool_use","id":"call_original","name":"lookup","input":{}}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":1,
                "delta":{"type":"input_json_delta","partial_json":&full}})
        )
    );
    let wrong_index_frames = frames(&wrong_index);
    assert!(
        anthropic_tool_input_partial_json(&wrong_index_frames, 0).is_empty(),
        "fragments for another index cannot satisfy block 0"
    );

    let out_of_order = format!(
        "{}{}{}",
        sse(
            "content_block_start",
            &json!({"type":"content_block_start","index":0,
                "content_block":{"type":"tool_use","id":"call_original","name":"lookup","input":{}}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":0,
                "delta":{"type":"input_json_delta","partial_json":&full[split_at..]}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":0,
                "delta":{"type":"input_json_delta","partial_json":&full[..split_at]}})
        )
    );
    let out_of_order_frames = frames(&out_of_order);
    let reassembled = anthropic_tool_input_partial_json(&out_of_order_frames, 0);
    assert_ne!(
        serde_json::from_str::<Value>(&reassembled).ok(),
        Some(input.clone()),
        "out-of-order fragments cannot satisfy the successful reconstruction"
    );
}

#[tokio::test]
async fn anthropic_custom_calls_execute_and_return_original_kind_and_input() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let previous =
        json!({"type":"tool_use","id":"call_original","name":"lookup","input":{"previous":1}});
    let previous_execution = std::process::Command::new("node").args([
        "-e", "const c=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({received:c.input}));", &previous.to_string()
    ]).output().unwrap();
    assert!(previous_execution.status.success());
    let previous_output = String::from_utf8(previous_execution.stdout).unwrap();
    for value in [
        json!({"q":1,"nested":{"input":"keep"}}),
        json!({"input":"natural object field"}),
        json!([1,{"keep":true}]),
        Value::Null,
        json!(true),
        json!(7),
        json!(7.25),
        json!(" exact input \n"),
        json!(""),
    ] {
        for mode in 0..4 {
            let item = json!({"type":"custom_tool_call","id":"custom_original","call_id":"call_original","name":"lookup","input":value});
            let mut response = text_response("execute actual custom call");
            response["output"] = json!([item]);
            let (media, wire) = if mode < 2 {
                ("application/json", response.to_string())
            } else {
                let prior = if mode == 3 {
                    sse(
                        "response.output_item.done",
                        &json!({"type":"response.output_item.done","output_index":0,"item":item}),
                    )
                } else {
                    String::new()
                };
                ("text/event-stream", prior + &response_sse(&response))
            };
            let (endpoint, handle, mut captures, shutdown) =
                start_entry("responses", "chat", StatusCode::OK, media, wire).await;
            let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
            let tools = json!([{"name":"lookup","input_schema":{"type":"object"}}]);
            let (media, body) = successful_transfer(
                client()
                    .post(&endpoint)
                    .json(&json!({
                        "model":"test.test","max_tokens":128,"tools":tools,"stream":mode != 0,
                        "messages":[{"role":"user","content":"execute custom"}]
                    }))
                    .send()
                    .await,
            )
            .await;
            let content: Vec<Value> = if media.starts_with("application/json") {
                serde_json::from_str::<Value>(&body).unwrap()["content"]
                    .as_array()
                    .unwrap()
                    .clone()
            } else {
                anthropic_sse_content_blocks(&body)
            };
            let call = content
                .iter()
                .find(|part| part["type"] == "tool_use")
                .unwrap()
                .clone();
            assert_eq!(call["id"], "call_original");
            assert_eq!(call["name"], "lookup");
            let projected = if value.is_object() {
                value.clone()
            } else {
                json!({"input":value})
            };
            assert_eq!(call["input"], projected, "mode={mode}: {body}");
            assert_one_attempt(&mut captures, "wire-test").await;
            let execution = std::process::Command::new("node").args([
                "-e","const c=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({received:c.input}));", &call.to_string()
            ]).output().unwrap();
            assert!(execution.status.success());
            let output = String::from_utf8(execution.stdout).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&output).unwrap(),
                json!({"received":projected})
            );
            let (_, completed) = successful_transfer(client().post(&endpoint).json(&json!({
                "model":"test.test","max_tokens":128,"tools":tools,"stream":mode != 0,
                "messages":[{"role":"user","content":"execute custom"},
                    {"role":"assistant","content":[previous]},
                    {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_original","content":previous_output}]},
                    {"role":"assistant","content":[call]},
                    {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_original","content":output}]}]
            })).send().await).await;
            assert!(
                completed.contains("mixed roundtrip complete"),
                "{completed}"
            );
            stop_entry(handle, shutdown).await;
            let wire = captures.recv().await.unwrap();
            let input = wire["input"].as_array().unwrap();
            let sent = input
                .iter()
                .find(|part| part["type"] == "custom_tool_call")
                .unwrap_or_else(|| panic!("custom call kind lost mode={mode}: {wire}"));
            assert_eq!(sent["id"], item["id"], "{wire}");
            assert_eq!(sent["call_id"], item["call_id"], "{wire}");
            assert_eq!(sent["name"], item["name"], "{wire}");
            assert_eq!(sent["input"], value, "mode={mode}: {wire}");
            let result = input
                .iter()
                .find(|part| part["type"] == "custom_tool_call_output")
                .unwrap_or_else(|| panic!("custom result kind lost: {wire}"));
            assert_eq!(result["call_id"], "call_original");
            assert_eq!(result["output"], output);
            assert!(
                input
                    .iter()
                    .any(|part| part["type"] == "function_call_output"
                        && part["output"] == previous_output),
                "{wire}"
            );
            assert!(matches!(
                captures.try_recv(),
                Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
            ));
            for target in ["openai_chat", "anthropic"] {
                let completed = if target == "openai_chat" {
                    json!({"id":"chat-followup","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":"custom followup complete"},"finish_reason":"stop"}]})
                } else {
                    json!({"id":"msg-followup","type":"message","role":"assistant","model":"wire-test","content":[{"type":"text","text":"custom followup complete"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}})
                };
                let (next, next_handle, mut next_captures, next_shutdown) = start_entry(
                    target,
                    "chat",
                    StatusCode::OK,
                    "application/json",
                    completed.to_string(),
                )
                .await;
                let next = next.replace("/v1/responses", "/v1/messages");
                let (_, body) = successful_transfer(client().post(next).json(&json!({
                    "model":"test.test","max_tokens":128,"tools":tools,"stream":mode != 0,
                    "messages":[{"role":"user","content":"execute custom"},
                        {"role":"assistant","content":[call]},
                        {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_original","content":output}]}]
                })).send().await).await;
                assert!(
                    body.contains(if target == "openai_chat" {
                        "chat roundtrip complete"
                    } else {
                        "custom followup complete"
                    }),
                    "{body}"
                );
                stop_entry(next_handle, next_shutdown).await;
                let wire = next_captures.recv().await.unwrap();
                let messages = wire["messages"].as_array().unwrap();
                if target == "openai_chat" {
                    let sent = messages
                        .iter()
                        .find_map(|m| m["tool_calls"].as_array())
                        .unwrap()
                        .first()
                        .unwrap();
                    assert_eq!(sent["id"], "call_original");
                    assert_eq!(sent["function"]["name"], "lookup");
                    assert_eq!(
                        serde_json::from_str::<Value>(
                            sent["function"]["arguments"].as_str().unwrap()
                        )
                        .unwrap(),
                        json!({"input":value}),
                        "{wire}"
                    );
                    let result = messages.iter().find(|m| m["role"] == "tool").unwrap();
                    assert_eq!(result["tool_call_id"], "call_original");
                    assert_eq!(result["content"], output);
                } else {
                    let blocks: Vec<&Value> = messages
                        .iter()
                        .flat_map(|m| m["content"].as_array().unwrap())
                        .collect();
                    let sent = blocks.iter().find(|b| b["type"] == "tool_use").unwrap();
                    assert_eq!(sent["id"], "call_original");
                    assert_eq!(sent["name"], "lookup");
                    assert_eq!(sent["input"], json!({"input":value}), "{wire}");
                    let result = blocks.iter().find(|b| b["type"] == "tool_result").unwrap();
                    assert_eq!(result["tool_use_id"], "call_original");
                    assert_eq!(result["content"], output);
                }
                assert!(matches!(
                    next_captures.try_recv(),
                    Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
                ));
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_responses_custom_inputs_preserve_every_present_json_value() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let values = [
        json!({"q":" exact input \n","nested":[1,2]}),
        json!([1,{"keep":true}]),
        Value::Null,
        json!(true),
        json!(7),
        json!("{\"q\":\"exact\"}"),
        json!("{\"q\":"),
        json!(""),
    ];
    for value in values {
        for reason in [
            None,
            Some("provider_specific_reason"),
            Some("content_filter"),
            Some("max_output_tokens"),
        ] {
            for mode in 0..4 {
                let item = json!({"type":"custom_tool_call","call_id":"call_original","name":"lookup","input":value});
                let mut expected = text_response(" exact text \n");
                expected["output"]
                    .as_array_mut()
                    .unwrap()
                    .push(item.clone());
                if let Some(reason) = reason {
                    expected["status"] = json!("incomplete");
                    expected["incomplete_details"] = json!({"reason":reason});
                }
                let (media, wire) = if mode < 2 {
                    ("application/json", expected.to_string())
                } else {
                    let mut wire = String::new();
                    if mode == 3 {
                        wire.push_str(&sse("response.output_item.done",&json!({"type":"response.output_item.done","output_index":1,"item":item})));
                    }
                    wire.push_str(&response_sse(&expected));
                    ("text/event-stream", wire)
                };
                let (endpoint, handle, mut captures, shutdown) =
                    start_entry("responses", "chat", StatusCode::OK, media, wire).await;
                let endpoint = endpoint.replace("/v1/responses", "/v1/messages");
                let (media,body) = successful_transfer(client().post(&endpoint).json(&json!({"model":"test.test","max_tokens":128,
                    "messages":[{"role":"user","content":"preserve complete custom input"}],"stream":mode != 0,"tools":[{"name":"lookup","input_schema":{"type":"object"}}]})).send().await).await;
                let content: Vec<Value> = if media.starts_with("application/json") {
                    serde_json::from_str::<Value>(&body).unwrap()["content"]
                        .as_array()
                        .unwrap()
                        .clone()
                } else {
                    anthropic_sse_content_blocks(&body)
                };
                let call = content
                    .iter()
                    .find(|block| block["type"] == "tool_use")
                    .unwrap();
                assert_eq!(call["id"], "call_original");
                assert_eq!(call["name"], "lookup");
                assert_eq!(
                    call["input"],
                    if value.is_object() {
                        value.clone()
                    } else {
                        json!({"input":value})
                    },
                    "reason={reason:?} mode={mode}: {body}"
                );
                assert_one_attempt(&mut captures, "wire-test").await;
                stop_entry(handle, shutdown).await;
            }
        }
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_sse_preserves_each_responses_output_item_without_repetition() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let message = |text: &str| text_response(text)["output"][0].clone();
    let reasoning =
        json!({"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]});
    let tool = json!({"type":"function_call","call_id":"call_item","name":"lookup","arguments":"{\"q\":\"alpha\"}"});
    for layout in 0..4 {
        let (items, mut upstream, expected, expected_reasoning, has_tool) = match layout {
            0 => (vec![message("body")], String::new(), "body", "", false),
            1 => (
                vec![message("first"), message("second")],
                sse(
                    "response.output_text.delta",
                    &json!({"type":"response.output_text.delta","output_index":0,"delta":"first"}),
                ),
                "firstsecond",
                "",
                false,
            ),
            2 => (
                vec![tool.clone(), message("body")],
                String::new(),
                "body",
                "",
                true,
            ),
            _ => (
                vec![reasoning.clone(), message("body")],
                sse(
                    "response.reasoning_summary_text.delta",
                    &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"thinking"}),
                ),
                "bodyextra",
                "thinking",
                false,
            ),
        };
        for (index, item) in items.iter().enumerate() {
            upstream.push_str(&sse(
                "response.output_item.done",
                &json!({"type":"response.output_item.done","output_index":index,"item":item}),
            ));
        }
        let mut output = if layout == 0 { vec![] } else { items };
        if layout == 3 {
            output.push(message("extra"));
        }
        upstream.push_str(&response_sse(&json!({"status":"incomplete","output":output,"usage":{"input_tokens":3,"output_tokens":2}})));
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            "text/event-stream",
            upstream,
        )
        .await;
        let endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
        let response = client().post(&endpoint).json(&json!({"model":"test.test","messages":[{"role":"user","content":"indexed output"}],"stream":true,"stream_options":{"include_usage":true}})).send().await;
        let body = successful_body(response).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let frames = events(&body);
        let text = |field: &str| {
            frames
                .iter()
                .filter_map(|frame| frame["choices"][0]["delta"][field].as_str())
                .collect::<String>()
        };
        assert_eq!(text("content"), expected, "layout {layout}: {body}");
        assert_eq!(
            text("reasoning_content"),
            expected_reasoning,
            "layout {layout}: {body}"
        );
        let calls: Vec<_> = frames
            .iter()
            .filter_map(|frame| frame["choices"][0]["delta"]["tool_calls"].as_array())
            .flatten()
            .collect();
        assert_eq!(
            calls.len(),
            usize::from(has_tool),
            "layout {layout}: {body}"
        );
        if has_tool {
            assert_eq!(calls[0]["function"]["arguments"], tool["arguments"]);
        }
        assert!(
            frames
                .iter()
                .any(|frame| frame["choices"][0]["finish_reason"]
                    == if has_tool {
                        json!("tool_calls")
                    } else {
                        Value::Null
                    }),
            "{body}"
        );
        assert!(
            frames
                .iter()
                .any(|frame| frame["usage"]["total_tokens"] == 5),
            "{body}"
        );
    }
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn chat_sse_multiple_reasoning_summary_parts_are_returned_once() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let item = json!({"type":"reasoning","summary":[{"type":"summary_text","text":"A"},{"type":"summary_text","text":"B"}]});
    let mut completed = text_response("visible summary control");
    completed["output"]
        .as_array_mut()
        .unwrap()
        .insert(0, item.clone());
    let upstream = [
        sse("response.reasoning_summary_text.delta", &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"A"})),
        sse("response.reasoning_summary_text.delta", &json!({"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":1,"delta":"B"})),
        sse("response.output_item.done", &json!({"type":"response.output_item.done","output_index":0,"item":item})),
        response_sse(&completed),
    ].concat();
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "responses",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let response = client().post(endpoint.replace("/v1/responses", "/v1/chat/completions")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"summary"}],"stream":true})).send().await;
    let body = successful_body(response).await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    assert_eq!(
        events(&body)
            .iter()
            .filter_map(|frame| frame["choices"][0]["delta"]["reasoning_content"].as_str())
            .collect::<String>(),
        "A\nB",
        "{body}"
    );
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn anthropic_entry_retains_chat_text_and_refusal_together() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream = format!(
        "{}{}data: [DONE]\n\n",
        sse(
            "message",
            &json!({"id":"chat_mixed","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{"content":" partial answer ","refusal":" cannot continue ","reasoning_content":" preserved reasoning "},"finish_reason":null}]})
        ),
        sse(
            "message",
            &json!({"id":"chat_mixed","object":"chat.completion.chunk","model":"wire-test","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]})
        )
    );
    for stream in [false, true] {
        let (content_type, wire) = if stream {
            ("text/event-stream", upstream.clone())
        } else {
            ("application/json", json!({"id":"chat_mixed","object":"chat.completion","model":"wire-test","choices":[{"index":0,"message":{"role":"assistant","content":" partial answer ","refusal":" cannot continue ","reasoning_content":" preserved reasoning "},"finish_reason":"content_filter"}]}).to_string())
        };
        let (endpoint, handle, mut captures, shutdown) =
            start_entry("openai_chat", "chat", StatusCode::OK, content_type, wire).await;
        let response = client().post(endpoint.replace("/v1/responses", "/v1/messages")).json(&json!({"model":"test.test","messages":[{"role":"user","content":"mixed refusal"}],"max_tokens":128,"stream":stream})).send().await;
        let (content_type, body) = successful_transfer(response).await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        let text = if content_type.starts_with("application/json") {
            let payload: Value = serde_json::from_str(&body).unwrap();
            payload["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|block| block["text"].as_str())
                .collect::<String>()
        } else {
            events(&body)
                .iter()
                .filter_map(|frame| {
                    frame["delta"]["text"]
                        .as_str()
                        .or_else(|| frame["content_block"]["text"].as_str())
                })
                .collect::<String>()
        };
        assert_eq!(
            text, " partial answer  cannot continue ",
            "stream={stream}: {body}"
        );
        let thinking = if content_type.starts_with("application/json") {
            let payload: Value = serde_json::from_str(&body).unwrap();
            payload["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|block| block["thinking"].as_str())
                .collect::<String>()
        } else {
            events(&body)
                .iter()
                .filter_map(|frame| frame["delta"]["thinking"].as_str())
                .collect::<String>()
        };
        assert_eq!(thinking, " preserved reasoning ", "stream={stream}: {body}");
    }
    std::env::remove_var(KEY_ENV);
}

async fn assert_incomplete_transport(result: Result<reqwest::Response, reqwest::Error>) {
    match result {
        Err(error) => assert!(
            !error.is_timeout() && !error.is_connect(),
            "must terminate admitted request, not time out/connect fail: {error}"
        ),
        Ok(mut response) => {
            assert_eq!(response.status(), StatusCode::OK, "no client HTTP error");
            let mut body = Vec::new();
            let incomplete = loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    Ok(None) => break false,
                    Err(error) => {
                        assert!(!error.is_timeout(), "failure terminates promptly");
                        break true;
                    }
                }
            };
            let body = String::from_utf8(body).unwrap();
            assert!(
                !body.contains("provider secret error body")
                    && !body.contains("QSA pooled hold")
                    && !body.contains("controlled native error")
                    && !body.contains("response.failed")
                    && !body.contains("response.completed")
                    && !body.contains("event: error")
                    && !body.contains("\"error\""),
                "failure leaked or became fake success: {body}"
            );
            assert!(
                incomplete,
                "terminal failure requires incomplete transfer: {body}"
            );
        }
    }
}
/// HTTP500 and native HTTP200 SSE errors are distinct failure controls. Neither
/// may become a client error or a fabricated completion; independent traffic lives.
#[tokio::test]
async fn genuine_http_and_native_sse_errors_break_transport_without_client_error() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (kind, process) in [
        ("responses", "direct"),
        ("responses", "chat"),
        ("openai_chat", "chat"),
        ("anthropic", "chat"),
    ] {
        let mut failures = vec![
            (
                StatusCode::BAD_GATEWAY,
                "application/json",
                json!({"error":{"type":"server_error","message":"QSA pooled hold 46846 rows; resizing to 20480 would cut them"}})
                    .to_string(),
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "application/json",
                json!({"error":{"type":"server_error","message":"provider secret error body"}})
                    .to_string(),
            ),
            (
                StatusCode::OK,
                "text/event-stream",
                sse(
                    "error",
                    &json!({"type":"error","error":{"type":"server_error","message":"controlled native error"}}),
                ),
            ),
        ];
        if kind == "responses" {
            failures.push((StatusCode::OK, "text/event-stream", sse("response.failed",
                &json!({"type":"response.failed","response":{"id":"resp_failed","status":"failed","error":{"code":"server_error","message":"controlled native error"},"output":[]}}))));
        } else if kind == "openai_chat" {
            failures.push((
                StatusCode::OK,
                "text/event-stream",
                format!(
                    "data: {}\n\n",
                    json!({"error":{"type":"server_error","message":"controlled native error"}})
                ),
            ));
        }
        for (status, content_type, upstream) in failures {
            let (endpoint, handle, mut captures, shutdown) =
                start_entry(kind, process, status, content_type, upstream).await;
            let client = client();
            assert_incomplete_transport(post_request(&client, &endpoint, "test.test").await).await;
            assert_one_attempt(&mut captures, "wire-test").await;
            let body =
                successful_body(post_request(&client, &endpoint, "independent.test").await).await;
            stop_entry(handle, shutdown).await;
            assert_one_attempt(&mut captures, "wire-independent").await;
            let payloads = events(&body);
            let terminal = payloads
                .iter()
                .find(|event| event["type"] == "response.completed")
                .expect("independent request completes");
            assert_eq!(
                terminal["response"]["output"],
                text_response("independent ok")["output"]
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

// --- Recovery / exhaustion public entry for unharvestable tool markup ---

/// The public client request declares `exec_command` as a function tool with a
/// string `cmd` parameter. The Response Direct composition resolves an
/// attempted invocation only from declarations the request actually carried.
fn exec_command_tools() -> Value {
    json!([{
        "type": "function",
        "name": "exec_command",
        "description": "Run one bounded command.",
        "parameters": {
            "type": "object",
            "properties": {"cmd": {"type": "string"}},
            "required": ["cmd"]
        }
    }])
}

async fn post_exec_command_request(
    client: &reqwest::Client,
    endpoint: &str,
    model: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    client
        .post(endpoint)
        .json(&json!({
            "model": model,
            "input": "controlled unharvestable tool markup regression",
            "stream": true,
            "tools": exec_command_tools()
        }))
        .send()
        .await
}

/// Build one controlled provider attempt. JSON is a complete response object.
/// SSE with `closeout` uses the legal-closeout seal; without it the attempts
/// end at the terminal/EOF seal.
fn attempt_wire(content_type: &str, text: &str, closeout: bool) -> String {
    if content_type == "application/json" {
        text_response(text).to_string()
    } else if closeout {
        format!("{}data: [DONE]\n\n", response_sse(&text_response(text)))
    } else {
        response_sse(&text_response(text))
    }
}

fn assert_provider_declares_exec_command(request: &Value) {
    assert_eq!(request["model"], "wire-test", "{request}");
    let tools = request["tools"]
        .as_array()
        .expect("provider-bound Responses request must carry tools");
    let tool = tools
        .iter()
        .find(|tool| tool["name"] == "exec_command")
        .unwrap_or_else(|| panic!("exec_command declaration must reach the provider: {request}"));
    assert_eq!(tool["type"], "function", "{request}");
    assert_eq!(
        tool["parameters"]["properties"]["cmd"]["type"], "string",
        "{request}"
    );
}

async fn recv_attempt(captures: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .expect("provider attempt within timeout")
        .expect("provider attempt captured")
}

fn assert_no_error_payload(body: &str) {
    for forbidden in [
        "\"error\"",
        "event: error",
        "response.failed",
        "response.error",
        "network_error",
        "provider_response_empty",
        "500-211",
        "internal_599",
        "\"502\"",
    ] {
        assert!(
            !body.contains(forbidden),
            "client must not receive {forbidden:?}: {body}"
        );
    }
}

/// A recovered attempt must deliver no native tool item and no attempted tool
/// text. Request declarations echoed in a response envelope are not business
/// output, so only delivered items, deltas, and text parts are inspected.
fn assert_no_native_or_attempted_tool(body: &str) {
    for event in events(body) {
        let null = Value::Null;
        let first_output = event["response"]["output"]
            .as_array()
            .and_then(|items| items.first())
            .unwrap_or(&null);
        for item in [&event["item"], first_output] {
            assert_ne!(
                item["type"], "function_call",
                "native call delivered: {event}"
            );
            assert_ne!(
                item["type"], "custom_tool_call",
                "native call delivered: {event}"
            );
            assert_ne!(
                item["name"], "exec_command",
                "attempted tool delivered: {event}"
            );
        }
        let text = event["delta"]["text"]
            .as_str()
            .or_else(|| event["delta"].as_str())
            .or_else(|| event["text"].as_str())
            .or_else(|| event["item"]["content"][0]["text"].as_str())
            .unwrap_or_default();
        assert!(
            !text.contains("exec_command") && !text.contains("<|DSML|"),
            "attempted tool markup leaked into business text: {event}"
        );
    }
}

/// Two eligible candidates: the first returns `first_text`, the second returns
/// `recovered_text`. The client must see only the second business text, in JSON
/// and SSE upstream form, after exactly two attempts on distinct keys.
async fn assert_direct_recovery(
    first_text: &str,
    recovered_text: &str,
    forbidden: &[&str],
    red_id: &str,
) {
    assert_markup_recovery("direct", first_text, recovered_text, forbidden, red_id).await;
}

async fn assert_markup_recovery(
    mode: &str,
    first_text: &str,
    recovered_text: &str,
    forbidden: &[&str],
    red_id: &str,
) {
    std::env::set_var(RECOVERY_KEY_ENV, "recovery-secret-b");
    for (content_type, closeout) in [("application/json", false), ("text/event-stream", true)] {
        let options = EntryOptions {
            attempt_bodies: vec![
                attempt_wire(content_type, first_text, closeout),
                attempt_wire(content_type, recovered_text, closeout),
            ],
            auth_entries: vec![
                ("first-key".to_string(), KEY_ENV.to_string()),
                ("second-key".to_string(), RECOVERY_KEY_ENV.to_string()),
            ],
            capture_headers: true,
            ..EntryOptions::default()
        };
        let (endpoint, handle, mut captures, headers, shutdown) = start_entry_configured(
            "responses",
            mode,
            StatusCode::OK,
            content_type,
            String::new(),
            options,
        )
        .await;
        let mut headers = headers.expect("recovery fixture must capture provider auth headers");
        let consumed =
            consume_response(post_exec_command_request(&client(), &endpoint, "test.test").await)
                .await;
        let first = recv_attempt(&mut captures).await;
        let second = recv_attempt(&mut captures).await;
        let third = captures.try_recv().ok();
        let first_auth = headers.try_recv().expect("first candidate auth captured");
        let second_auth = headers.try_recv().expect("second candidate auth captured");
        stop_entry(handle, shutdown).await;

        assert_provider_declares_exec_command(&first);
        assert_provider_declares_exec_command(&second);
        assert!(
            third.is_none(),
            "{red_id} {content_type}: exactly two eligible attempts: {third:?}"
        );
        assert_ne!(
            first_auth, second_auth,
            "{red_id} {content_type}: the second attempt must use the next eligible key"
        );
        assert!(
            consumed.transport_error.is_none(),
            "{red_id} {content_type}: recovered transport must complete: {consumed:?}"
        );
        assert!(
            consumed.body.contains(recovered_text),
            "{red_id} {content_type}: second candidate business text must reach the client: {consumed:?}"
        );
        for marker in forbidden {
            assert!(
                !consumed.body.contains(*marker),
                "{red_id} {content_type}: first attempt content {marker:?} must not reach the client: {consumed:?}"
            );
        }
        assert_no_native_or_attempted_tool(&consumed.body);
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(RECOVERY_KEY_ENV);
}

/// Stable RED public ID (JSON + SSE upstream): recognized unharvestable tool
/// markup beside surviving prose rejects the whole first attempt. The next
/// eligible candidate supplies business text. The first attempt's prose,
/// marker, or native call must never reach the client.
#[tokio::test]
async fn responses_direct_unharvestable_tool_markup_recovers_json_and_sse() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    const MARKUP: &str = "must-never-be-delivered\n<|DSML|tool_calls>\n<|exec_command\">";
    assert_direct_recovery(
        MARKUP,
        "faithful recovery answer",
        &[
            "must-never-be-delivered",
            "<|DSML|tool_calls>",
            "<|exec_command",
        ],
        "responses_direct_unharvestable_tool_markup_recovers_json_and_sse",
    )
    .await;
    std::env::remove_var(KEY_ENV);
}

/// AppSDK master 4444 sample at 2026-10-20 21:27:27: visible prose followed
/// by an orphan DSML tool close is not a completed tool execution turn.
async fn assert_chat_json_governance_failure(
    text: &str,
    markup: bool,
    entry: &str,
    streaming: bool,
) {
    for recovery in [false, true] {
        let log = std::env::temp_dir().join(format!(
            "rcc-chat-governance-{}-{entry}-{streaming}-{markup}-{recovery}.log",
            std::process::id()
        ));
        std::env::set_var("V3_NO_RESPONSE_TEST_LOG_FILE", &log);
        let mut options = EntryOptions {
            health_enabled: true,
            attempt_bodies: vec![if streaming {
                response_sse(&text_response(text))
            } else {
                text_response(text).to_string()
            }],
            ..EntryOptions::default()
        };
        if recovery {
            options.auth_entries = vec![
                ("first".into(), KEY_ENV.into()),
                ("second".into(), RECOVERY_KEY_ENV.into()),
            ];
            options.attempt_bodies.push(if streaming {
                response_sse(&text_response("CHAT_GOVERNANCE_RECOVERED"))
            } else {
                text_response("CHAT_GOVERNANCE_RECOVERED").to_string()
            });
        }
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            "chat",
            StatusCode::OK,
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
            String::new(),
            options,
        )
        .await;
        let base = endpoint.trim_end_matches("/v1/responses");
        let (path, request) = match entry {
            "anthropic" => (
                "/v1/messages",
                json!({"model":"test.test","max_tokens":64,"messages":[{"role":"user","content":"Chat review fixture"}],"stream":false}),
            ),
            "gemini" => (
                "/v1beta/models/test.test/generateContent",
                json!({"contents":[{"role":"user","parts":[{"text":"Chat review fixture"}]}]}),
            ),
            _ => (
                "/v1/chat/completions",
                json!({"model":"test.test","messages":[{"role":"user","content":"Chat review fixture"}],"stream":streaming}),
            ),
        };
        let consumed = consume_response(
            client()
                .post(format!("{base}{path}"))
                .json(&request)
                .send()
                .await,
        )
        .await;
        let health: Value = client()
            .get(format!("{base}/_routecodex/health/cooldown-pool"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        stop_entry(handle, shutdown).await;
        if recovery {
            assert!(consumed.transport_error.is_none(), "{consumed:?}");
            assert!(
                consumed.body.contains("CHAT_GOVERNANCE_RECOVERED"),
                "{consumed:?}"
            );
        } else {
            assert!(
                consumed.transport_error.is_some(),
                "must terminate without empty success: {consumed:?}"
            );
        }
        assert!(!consumed.body.contains("must-not-leak"), "{consumed:?}");
        assert_no_error_payload(&consumed.body);
        if markup {
            assert!(
                health["entries"].as_array().unwrap().is_empty(),
                "markup failure must be health neutral: {health}"
            );
        }
        let mut attempts = 0;
        while let Some(capture) = captures.recv().await {
            if capture.to_string().contains("Chat review fixture") {
                attempts += 1;
            }
        }
        assert_eq!(attempts, if recovery { 2 } else { 1 });
        if markup && recovery {
            let observed = std::fs::read_to_string(&log).unwrap();
            assert!(
                observed.contains("relay_unharvestable_tool_markup")
                    || observed.contains("V3HubRelayResp03UnharvestableToolMarkup"),
                "dedicated typed markup source missing"
            );
        }
        std::env::remove_var("V3_NO_RESPONSE_TEST_LOG_FILE");
    }
}

#[tokio::test]
async fn issuee63d2f2_chat_json_control_only_recovers_or_terminates() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "controlled-recovery");
    assert_chat_json_governance_failure("<|end_of_analysis|>", false, "chat", false).await;
    std::env::remove_var(KEY_ENV);
    std::env::remove_var(RECOVERY_KEY_ENV);
}

#[tokio::test]
async fn issuee63d2f2_chat_json_orphan_retains_typed_health_neutral_cause() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "controlled-recovery");
    assert_chat_json_governance_failure(
        "must-not-leak\n\n</｜DSML｜tool_calls>",
        true,
        "chat",
        false,
    )
    .await;
    std::env::remove_var(KEY_ENV);
    std::env::remove_var(RECOVERY_KEY_ENV);
}

#[tokio::test]
async fn issuee63d2f2_other_json_callers_retain_governance_failure() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "controlled-recovery");
    for entry in ["anthropic", "gemini"] {
        assert_chat_json_governance_failure("<|end_of_analysis|>", false, entry, false).await;
        assert_chat_json_governance_failure(
            "must-not-leak\n\n</｜DSML｜tool_calls>",
            true,
            entry,
            false,
        )
        .await;
    }
    std::env::remove_var(KEY_ENV);
    std::env::remove_var(RECOVERY_KEY_ENV);
}

#[tokio::test]
async fn issuee63d2f2_chat_sse_control_only_recovers_or_terminates() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "controlled-recovery");
    assert_chat_json_governance_failure("<|end_of_analysis|>", false, "chat", true).await;
    std::env::remove_var(KEY_ENV);
    std::env::remove_var(RECOVERY_KEY_ENV);
}

fn chat_sse_responses_deltas(deltas: &[&str], response: Value) -> String {
    let mut upstream = String::new();
    for delta in deltas {
        upstream.push_str(&sse(
            "response.output_text.delta",
            &json!({
                "type": "response.output_text.delta",
                "item_id": "msg_fragmented",
                "output_index": 0,
                "content_index": 0,
                "delta": delta
            }),
        ));
    }
    upstream.push_str(&response_sse(&response));
    upstream
}

fn completed_empty_response() -> Value {
    json!({
        "id": "resp_fragmented",
        "object": "response",
        "status": "completed",
        "model": "wire-test",
        "output": []
    })
}

fn chat_sse_chunk(delta: Value, finish_reason: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_fragmented",
            "object": "chat.completion.chunk",
            "model": "wire-test",
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason
            }]
        })
    )
}

/// The first candidate closes an orphan tool envelope across two Responses
/// delta events. Per-event projection must not reject the unfinished first
/// fragment as an orphan. The complete callback aggregates the exact carrier
/// and discards the whole attempt with the registered health-neutral typed
/// cause; only the next candidate's business output may reach the client.
#[tokio::test]
async fn issuee63d2f2_chat_sse_fragmented_orphan_recovers_or_terminates() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "controlled-recovery");
    let first_upstream = chat_sse_responses_deltas(
        &["must-not-leak\n\n</｜DSML｜tool_", "calls>"],
        completed_empty_response(),
    );
    for recovery in [false, true] {
        let log = std::env::temp_dir().join(format!(
            "rcc-chat-sse-fragmented-orphan-{}-{recovery}.log",
            std::process::id()
        ));
        std::env::set_var("V3_NO_RESPONSE_TEST_LOG_FILE", &log);
        let mut options = EntryOptions {
            health_enabled: true,
            attempt_bodies: vec![first_upstream.clone()],
            ..EntryOptions::default()
        };
        if recovery {
            options.auth_entries = vec![
                ("first".into(), KEY_ENV.into()),
                ("second".into(), RECOVERY_KEY_ENV.into()),
            ];
            options
                .attempt_bodies
                .push(response_sse(&text_response("CHAT_FRAGMENTED_RECOVERED")));
        }
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            "chat",
            StatusCode::OK,
            "text/event-stream",
            String::new(),
            options,
        )
        .await;
        let base = endpoint.trim_end_matches("/v1/responses");
        let consumed = consume_response(
            client()
                .post(format!("{base}/v1/chat/completions"))
                .json(&json!({
                    "model": "test.test",
                    "messages": [{"role": "user", "content": "fragmented orphan"}],
                    "stream": true
                }))
                .send()
                .await,
        )
        .await;
        let health: Value = client()
            .get(format!("{base}/_routecodex/health/cooldown-pool"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        stop_entry(handle, shutdown).await;
        if recovery {
            assert!(
                consumed.transport_error.is_none(),
                "the next candidate must recover: {consumed:?}"
            );
            assert!(
                consumed.body.contains("CHAT_FRAGMENTED_RECOVERED"),
                "{consumed:?}"
            );
        } else {
            assert!(
                consumed.transport_error.is_some(),
                "fragmented orphan exhaustion must terminate transport: {consumed:?}"
            );
            assert!(
                !consumed.body.contains("response.completed") && !consumed.body.contains("[DONE]"),
                "no normal empty completion may reach the client: {consumed:?}"
            );
        }
        assert!(!consumed.body.contains("must-not-leak"), "{consumed:?}");
        assert!(!consumed.body.contains("DSML"), "{consumed:?}");
        assert_no_error_payload(&consumed.body);
        assert!(
            health["entries"].as_array().unwrap().is_empty(),
            "the fragmented orphan is a health-neutral response-governance failure: {health}"
        );
        let mut attempts = 0;
        while let Some(capture) = captures.recv().await {
            if capture.to_string().contains("fragmented orphan") {
                attempts += 1;
            }
        }
        assert_eq!(attempts, if recovery { 2 } else { 1 });
        if recovery {
            let observed = std::fs::read_to_string(&log).unwrap();
            assert!(
                observed.contains("relay_unharvestable_tool_markup")
                    || observed.contains("V3HubRelayResp03UnharvestableToolMarkup"),
                "the original typed orphan cause must remain observable: {observed}"
            );
        }
        std::env::remove_var("V3_NO_RESPONSE_TEST_LOG_FILE");
    }
    std::env::remove_var(KEY_ENV);
    std::env::remove_var(RECOVERY_KEY_ENV);
}

/// A standalone control label split across two Responses deltas is removed
/// only after the exact Chat carrier is complete. Visible text around it stays
/// in byte order and the source terminal remains stop.
#[tokio::test]
async fn issuee63d2f2_chat_sse_fragmented_label_preserves_visible_order() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let upstream = chat_sse_responses_deltas(
        &["alpha\n<|end_of_", "analysis|>\nomega"],
        completed_empty_response(),
    );
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "responses",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let (content_type, body) = successful_transfer(
        client()
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({
                "model": "test.test",
                "messages": [{"role": "user", "content": "fragmented label"}],
                "stream": true
            }))
            .send()
            .await,
    )
    .await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    assert!(content_type.starts_with("text/event-stream"));
    let payloads = events(&body);
    assert_eq!(
        payloads
            .iter()
            .filter_map(|event| event["choices"][0]["delta"]["content"].as_str())
            .collect::<String>(),
        "alpha\nomega",
        "{body}"
    );
    assert!(!body.contains("end_of_analysis"), "{body}");
    assert!(
        payloads
            .iter()
            .any(|event| event["choices"][0]["finish_reason"] == "stop"),
        "the original normal terminal is preserved: {body}"
    );
    std::env::remove_var(KEY_ENV);
}

/// A valid Responses `response.incomplete` with no `incomplete_details.reason`
/// projects a Chat terminal with `finish_reason: null`. When a removable
/// standalone marker is cleaned beside surviving visible text, the typed
/// protocol-terminal witness must keep the attempt deliverable instead of
/// misclassifying it as processing damage and entering 599 recovery.
#[tokio::test]
async fn issuee63d2f2_reasonless_incomplete_marker_delivers_without_reselection() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for streaming in [false, true] {
        let mut response = text_response("<|end_of_analysis|>\nREASONLESS_OK");
        response["status"] = json!("incomplete");
        response["incomplete_details"] = Value::Null;
        response["output"][0]["status"] = json!("incomplete");
        let upstream = if streaming {
            response_sse(&response)
        } else {
            response.to_string()
        };
        let (endpoint, handle, mut captures, shutdown) = start_entry(
            "responses",
            "chat",
            StatusCode::OK,
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
            upstream,
        )
        .await;
        let base = endpoint.trim_end_matches("/v1/responses");
        let (content_type, body) = successful_transfer(
            client()
                .post(format!("{base}/v1/chat/completions"))
                .json(&json!({
                    "model": "test.test",
                    "messages": [{"role": "user", "content": "reasonless incomplete"}],
                    "stream": streaming
                }))
                .send()
                .await,
        )
        .await;
        stop_entry(handle, shutdown).await;
        assert_one_attempt(&mut captures, "wire-test").await;
        assert!(!body.contains("<|end_of_analysis|>"), "{streaming}: {body}");
        assert_no_error_payload(&body);
        if content_type.starts_with("application/json") {
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["choices"][0]["finish_reason"], Value::Null);
            assert_eq!(payload["choices"][0]["message"]["content"], "REASONLESS_OK");
        } else {
            let payloads = events(&body);
            assert_eq!(
                payloads
                    .iter()
                    .filter_map(|event| event["choices"][0]["delta"]["content"].as_str())
                    .collect::<String>(),
                "REASONLESS_OK",
                "{streaming}: {body}"
            );
            assert!(
                payloads
                    .iter()
                    .all(|event| event["choices"][0]["finish_reason"].is_null()),
                "the reason-less terminal stays null: {body}"
            );
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// Anthropic may close a complete visible response with `message_stop` and no
/// `stop_reason`. The projected Chat terminal keeps `finish_reason: null`, so
/// only the typed message_stop witness can keep a removable marker rewrite
/// from being misclassified as processing damage.
#[tokio::test]
async fn issuee63d2f2_anthropic_reasonless_message_stop_marker_delivers_without_reselection() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let provider_wire = format!(
        "{}{}{}{}{}{}",
        sse(
            "message_start",
            &json!({"type":"message_start","message":{"id":"msg_reasonless","type":"message",
                "role":"assistant","model":"wire-test","content":[],
                "stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}})
        ),
        sse(
            "content_block_start",
            &json!({"type":"content_block_start","index":0,
                "content_block":{"type":"text","text":""}})
        ),
        sse(
            "content_block_delta",
            &json!({"type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":"<|end_of_analysis|>\nANTHROPIC_REASONLESS_OK"}})
        ),
        sse(
            "content_block_stop",
            &json!({"type":"content_block_stop","index":0})
        ),
        sse(
            "message_delta",
            &json!({"type":"message_delta","delta":{},"usage":{"output_tokens":1}})
        ),
        sse("message_stop", &json!({"type":"message_stop"}))
    );
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "anthropic",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        provider_wire,
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let (content_type, body) = successful_transfer(
        client()
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({
                "model": "test.test",
                "messages": [{"role": "user", "content": "anthropic reasonless terminal"}],
                "stream": true
            }))
            .send()
            .await,
    )
    .await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    assert!(
        content_type.starts_with("text/event-stream"),
        "{content_type}"
    );
    assert!(!body.contains("<|end_of_analysis|>"), "{body}");
    assert_no_error_payload(&body);
    let payloads = events(&body);
    assert_eq!(
        payloads
            .iter()
            .filter_map(|event| event["choices"][0]["delta"]["content"].as_str())
            .collect::<String>(),
        "ANTHROPIC_REASONLESS_OK",
        "{body}"
    );
    assert!(
        payloads
            .iter()
            .all(|event| event["choices"][0]["finish_reason"].is_null()),
        "the reason-less Anthropic terminal stays null: {body}"
    );
    assert!(body.trim_end().ends_with("data: [DONE]"), "{body}");
    std::env::remove_var(KEY_ENV);
}

/// Gemini's normal STOP terminal can carry a function call. The Chat client
/// must receive `finish_reason: "tool_calls"`, execute the call, and send the
/// paired result back through the same public entry.
#[tokio::test]
async fn issuee63d2f2_gemini_stop_function_call_public_roundtrip() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let function_call = json!({
        "candidates": [{
            "index": 0,
            "finishReason": "STOP",
            "content": {
                "role": "model",
                "parts": [{
                    "functionCall": {
                        "id": "call_gemini_stop",
                        "name": "lookup",
                        "args": {"city": "Paris"}
                    }
                }]
            }
        }]
    });
    let completed = json!({
        "candidates": [{
            "index": 0,
            "finishReason": "STOP",
            "content": {
                "role": "model",
                "parts": [{"text": "gemini tool roundtrip complete"}]
            }
        }]
    });
    let tools = json!([{
        "type": "function",
        "name": "lookup",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"]
        }
    }]);

    for stream in [false, true] {
        let (endpoint, handle, mut captures, _headers, shutdown) = start_entry_configured(
            "gemini",
            "chat",
            StatusCode::OK,
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
            String::new(),
            EntryOptions {
                attempt_bodies: vec![
                    e63_review_wire("gemini", &function_call, stream),
                    e63_review_wire("gemini", &completed, stream),
                ],
                ..EntryOptions::default()
            },
        )
        .await;
        let chat_endpoint = endpoint.replace("/v1/responses", "/v1/chat/completions");
        let (_, first_body) = successful_transfer(
            client()
                .post(&chat_endpoint)
                .json(&json!({
                    "model": "test.test",
                    "stream": stream,
                    "messages": [{"role": "user", "content": "Use lookup for Paris"}],
                    "tools": tools.clone()
                }))
                .send()
                .await,
        )
        .await;
        assert_no_error_payload(&first_body);

        let call = if stream {
            assert_eq!(
                events(&first_body)
                    .into_iter()
                    .rev()
                    .find_map(|event| {
                        event["choices"][0]["finish_reason"]
                            .as_str()
                            .map(str::to_string)
                    })
                    .as_deref(),
                Some("tool_calls"),
                "{first_body}"
            );
            events(&first_body)
                .into_iter()
                .find_map(|event| {
                    event["choices"][0]["delta"]["tool_calls"]
                        .as_array()
                        .and_then(|calls| calls.first())
                        .cloned()
                })
                .expect("Gemini STOP function call reaches the Chat stream")
        } else {
            let payload: Value = serde_json::from_str(&first_body).unwrap();
            assert_eq!(
                payload["choices"][0]["finish_reason"], "tool_calls",
                "{first_body}"
            );
            payload["choices"][0]["message"]["tool_calls"][0].clone()
        };
        assert_eq!(call["id"], "call_gemini_stop");
        assert_eq!(call["function"]["name"], "lookup");

        let arguments = call["function"]["arguments"]
            .as_str()
            .expect("Chat tool arguments are a JSON string");
        let execution = std::process::Command::new("node")
            .args([
                "-e",
                "process.stdout.write(JSON.stringify({received:JSON.parse(process.argv[1])}));",
                arguments,
            ])
            .output()
            .unwrap();
        assert!(execution.status.success());
        let output = String::from_utf8(execution.stdout).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&output).unwrap(),
            json!({"received": {"city": "Paris"}})
        );

        let (_, followup_body) = successful_transfer(
            client()
                .post(&chat_endpoint)
                .json(&json!({
                    "model": "test.test",
                    "stream": stream,
                    "messages": [
                        {"role": "user", "content": "Use lookup for Paris"},
                        {"role": "assistant", "content": null, "tool_calls": [call]},
                        {"role": "tool", "tool_call_id": "call_gemini_stop", "content": output.clone()}
                    ],
                    "tools": tools.clone()
                }))
                .send()
                .await,
        )
        .await;
        assert_no_error_payload(&followup_body);
        assert!(
            followup_body.contains("gemini tool roundtrip complete"),
            "{stream}: {followup_body}"
        );
        stop_entry(handle, shutdown).await;

        let first_wire = captures.recv().await.expect("first Gemini attempt");
        assert_eq!(
            first_wire["tools"][0]["functionDeclarations"][0]["name"], "lookup",
            "{first_wire}"
        );
        let followup_wire = captures.recv().await.expect("Gemini follow-up attempt");
        assert_eq!(
            followup_wire["contents"].as_array().unwrap().len(),
            3,
            "{followup_wire}"
        );
        let function_response = &followup_wire["contents"][2]["parts"][0]["functionResponse"];
        assert_eq!(function_response["id"], "call_gemini_stop");
        assert_eq!(function_response["name"], "lookup");
        assert_eq!(function_response["response"]["output"], output);
        assert!(matches!(
            captures.try_recv(),
            Err(mpsc::error::TryRecvError::Empty | mpsc::error::TryRecvError::Disconnected)
        ));
    }
    std::env::remove_var(KEY_ENV);
}

/// Literal marker examples inside inline code or a fenced block remain
/// business text. They must not trigger marker removal or candidate recovery.
#[tokio::test]
async fn issuee63d2f2_chat_sse_literal_marker_context_stays_business() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let deltas = [
        "Inline `<|end_of_",
        "analysis|>` example.\n\n```text\n</｜DSML｜tool_",
        "calls>\n```\n多语言保留 café",
    ];
    let expected: String = deltas.concat();
    let upstream = chat_sse_responses_deltas(&deltas, completed_empty_response());
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "responses",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let (_, body) = successful_transfer(
        client()
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({
                "model": "test.test",
                "messages": [{"role": "user", "content": "literal marker context"}],
                "stream": true
            }))
            .send()
            .await,
    )
    .await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    let payloads = events(&body);
    assert_eq!(
        payloads
            .iter()
            .filter_map(|event| event["choices"][0]["delta"]["content"].as_str())
            .collect::<String>(),
        expected,
        "{body}"
    );
    assert!(body.contains("多语言保留 café"), "{body}");
    std::env::remove_var(KEY_ENV);
}

/// Relay Chat SSE receives role-only and usage-only frames before real
/// content. Those envelope frames must not classify the attempt as empty, and
/// native tool calls plus their original terminal must survive byte-preserving
/// governance.
#[tokio::test]
async fn issuee63d2f2_chat_sse_role_usage_native_tools_preserve_terminal() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let tool_calls = json!([{
        "index": 0,
        "id": "call_role_usage",
        "type": "function",
        "function": {"name": "lookup", "arguments": "{\"q\":\"hello\"}"}
    }]);
    let upstream = [
        chat_sse_chunk(json!({"role": "assistant"}), Value::Null),
        format!(
            "data: {}\n\n",
            json!({
                "id": "chatcmpl_fragmented",
                "object": "chat.completion.chunk",
                "model": "wire-test",
                "choices": [],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            })
        ),
        chat_sse_chunk(json!({"content": "ROLE_USAGE_CONTENT"}), Value::Null),
        chat_sse_chunk(json!({"tool_calls": tool_calls.clone()}), Value::Null),
        chat_sse_chunk(json!({}), json!("tool_calls")),
        "data: [DONE]\n\n".to_string(),
    ]
    .concat();
    let (endpoint, handle, mut captures, shutdown) = start_entry(
        "openai_chat",
        "relay",
        StatusCode::OK,
        "text/event-stream",
        upstream,
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let (_, body) = successful_transfer(
        client()
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({
                "model": "test.test",
                "messages": [{"role": "user", "content": "role and usage"}],
                "stream": true,
                "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}]
            }))
            .send()
            .await,
    )
    .await;
    stop_entry(handle, shutdown).await;
    assert_one_attempt(&mut captures, "wire-test").await;
    let payloads = events(&body);
    assert!(
        payloads.iter().any(|event| {
            event["choices"][0]["delta"]["content"].as_str() == Some("ROLE_USAGE_CONTENT")
        }),
        "{body}"
    );
    let delivered_calls: Vec<Value> = payloads
        .iter()
        .filter_map(|event| event["choices"][0]["delta"]["tool_calls"].as_array())
        .flatten()
        .cloned()
        .collect();
    assert_eq!(
        delivered_calls,
        tool_calls.as_array().unwrap().clone(),
        "{body}"
    );
    assert_eq!(
        payloads
            .iter()
            .filter_map(|event| event["choices"][0]["finish_reason"].as_str())
            .collect::<Vec<_>>(),
        vec!["tool_calls"],
        "{body}"
    );
    assert!(body.trim_end().ends_with("data: [DONE]"), "{body}");
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn issuee63d2f2_orphan_dsml_tool_close_recovers_json_and_sse() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for mode in ["direct", "relay"] {
        assert_markup_recovery(
            mode,
            "I will run the baseline tests next.\n\n</｜DSML｜tool_calls>",
            "faithful recovery answer",
            &["I will run the baseline tests next.", "DSML"],
            "issuee63d2f2_orphan_dsml_tool_close_recovers_json_and_sse",
        )
        .await;
    }
    std::env::remove_var(KEY_ENV);
}

/// Stable RED public ID (JSON + SSE upstream): a sole recognized tool label
/// leaves no business content after normalization, so the existing internal
/// `provider_response_empty` recovery must select the next candidate. The
/// label and every internal error marker stay out of the client response.
#[tokio::test]
async fn responses_direct_sole_dsml_label_recovers_empty_attempt_json_and_sse() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    assert_direct_recovery(
        "<|DSML|tool_calls>",
        "label recovery answer",
        &["<|DSML|tool_calls>"],
        "responses_direct_sole_dsml_label_recovers_empty_attempt_json_and_sse",
    )
    .await;
    std::env::remove_var(KEY_ENV);
}

/// Stable RED public ID (JSON + SSE upstream): when every eligible candidate
/// returns the same unharvestable tool markup, the request ends in a finite
/// detectable transport termination. No marker, error payload, client error
/// number, or normal empty completion may reach the client, and independent
/// traffic on the same listener still succeeds.
#[tokio::test]
async fn responses_direct_unharvestable_tool_markup_exhaustion_json_and_sse() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    std::env::set_var(RECOVERY_KEY_ENV, "recovery-secret-b");
    const MARKUP: &str = "must-never-be-delivered\n<|DSML|tool_calls>\n<|exec_command\">";
    for (content_type, closeout) in [("application/json", false), ("text/event-stream", false)] {
        let options = EntryOptions {
            auth_entries: vec![
                ("first-key".to_string(), KEY_ENV.to_string()),
                ("second-key".to_string(), RECOVERY_KEY_ENV.to_string()),
            ],
            capture_headers: true,
            ..EntryOptions::default()
        };
        let (endpoint, handle, mut captures, headers, shutdown) = start_entry_configured(
            "responses",
            "direct",
            StatusCode::OK,
            content_type,
            attempt_wire(content_type, MARKUP, closeout),
            options,
        )
        .await;
        let mut headers = headers.expect("exhaustion fixture must capture provider auth headers");
        let consumed =
            consume_response(post_exec_command_request(&client(), &endpoint, "test.test").await)
                .await;
        let first = recv_attempt(&mut captures).await;
        let second = recv_attempt(&mut captures).await;
        let extra = captures.try_recv().ok();
        let first_auth = headers.try_recv().expect("first candidate auth captured");
        let second_auth = headers.try_recv().expect("second candidate auth captured");
        assert_provider_declares_exec_command(&first);
        assert_provider_declares_exec_command(&second);
        assert!(
            extra.is_none(),
            "{content_type}: finite attempts, no repeated failed candidate: {extra:?}"
        );
        assert_ne!(
            first_auth, second_auth,
            "{content_type}: each candidate identity is attempted once"
        );
        assert!(
            consumed.transport_error.is_some(),
            "{content_type}: exhaustion must terminate the client transport: {consumed:?}"
        );
        assert!(
            consumed.status.is_none() || consumed.status == Some(StatusCode::OK),
            "{content_type}: no client HTTP error number: {consumed:?}"
        );
        assert!(
            !consumed.body.contains("must-never-be-delivered")
                && !consumed.body.contains("<|DSML|tool_calls>")
                && !consumed.body.contains("<|exec_command")
                && !consumed.body.contains("exec_command")
                && !consumed.body.contains("function_call")
                && !consumed.body.contains("custom_tool_call"),
            "{content_type}: failed attempt content must not reach the client: {consumed:?}"
        );
        assert!(
            !consumed.body.contains("response.completed") && !consumed.body.contains("[DONE]"),
            "{content_type}: no normal empty completion may be delivered: {consumed:?}"
        );
        assert_no_error_payload(&consumed.body);

        // The listener and an unrelated pinned identity remain healthy after
        // the exhausted request.
        let independent =
            successful_body(post_request(&client(), &endpoint, "independent.test").await).await;
        assert_one_attempt(&mut captures, "wire-independent").await;
        let payloads = events(&independent);
        let terminal = payloads
            .iter()
            .find(|event| event["type"] == "response.completed")
            .expect("independent request completes after exhaustion");
        assert_eq!(
            terminal["response"]["output"],
            text_response("independent ok")["output"]
        );
        stop_entry(handle, shutdown).await;
    }
    std::env::remove_var(RECOVERY_KEY_ENV);
    std::env::remove_var(KEY_ENV);
}

/// One controlled upstream body per entry: the fallback repeats the same
/// fixture so a refill request is still answered by a valid business response.
async fn refill_public_attempt(
    process: &str,
    stream: bool,
    wire: &str,
    request: Value,
) -> (ConsumedResponse, usize) {
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        process,
        StatusCode::OK,
        if stream {
            "text/event-stream"
        } else {
            "application/json"
        },
        wire.to_string(),
        EntryOptions {
            attempt_bodies: vec![wire.to_string()],
            // These tests assert the compiled default behavior.
            refill_max: None,
            ..EntryOptions::default()
        },
    )
    .await;
    let consumed = consume_response(client().post(&endpoint).json(&request).send().await).await;
    let attempts = std::iter::from_fn(|| captures.try_recv().ok()).count();
    stop_entry(handle, shutdown).await;
    (consumed, attempts)
}

/// RED evidence for the bounded Chat Process refill: a complete governed
/// response with non-empty business text, no tool call and no source summary
/// must issue one automatic continuation (original plus refill).
#[tokio::test]
async fn refill_default_one_second_request_red() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    for (process, stream) in [
        ("chat", false),
        ("chat", true),
        ("direct", false),
        ("direct", true),
    ] {
        let response = text_response("FIRST_BUSINESS");
        let wire = if stream {
            response_sse(&response)
        } else {
            response.to_string()
        };
        let (consumed, attempts) = refill_public_attempt(
            process,
            stream,
            &wire,
            json!({"model":"test.test","input":"refill trigger","stream":stream}),
        )
        .await;
        assert_eq!(
            attempts, 2,
            "{process}/{stream}: unsummarized business text must issue exactly one refill: {consumed:?}"
        );
        assert!(
            consumed.transport_error.is_none(),
            "{process}/{stream}: refill chain must deliver normally: {consumed:?}"
        );
        assert!(
            consumed.body.contains("FIRST_BUSINESS"),
            "{process}/{stream}: first business text must reach the client: {consumed:?}"
        );
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(KEY_ENV);
}

/// Green guard: an explicit non-empty source reasoning summary stops refill.
#[tokio::test]
async fn refill_summary_stops_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let response = json!({
        "id":"resp_summary",
        "object":"response",
        "status":"completed",
        "model":"wire-test",
        "output":[
            {
                "id":"rs_summary",
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":"SOURCE_SUMMARY"}]
            },
            {
                "id":"msg_summary",
                "type":"message",
                "role":"assistant",
                "status":"completed",
                "content":[{"type":"output_text","text":"SUMMARY_BUSINESS","annotations":[]}]
            }
        ]
    });
    for process in ["chat", "direct"] {
        let (consumed, attempts) = refill_public_attempt(
            process,
            false,
            &response.to_string(),
            json!({"model":"test.test","input":"refill summary guard","stream":false}),
        )
        .await;
        assert_eq!(
            attempts, 1,
            "{process}: a non-empty source summary must stop refill: {consumed:?}"
        );
        assert!(
            consumed.transport_error.is_none(),
            "{process}: summary business must deliver normally: {consumed:?}"
        );
        assert!(
            consumed.body.contains("SUMMARY_BUSINESS"),
            "{process}: summary business text must reach the client: {consumed:?}"
        );
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(KEY_ENV);
}

/// Green guard: a real tool call is a terminal business result, not refill.
#[tokio::test]
async fn refill_tool_call_stops_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let response = json!({
        "id":"resp_tool",
        "object":"response",
        "status":"completed",
        "model":"wire-test",
        "output":[
            {
                "id":"fc_echo",
                "type":"function_call",
                "call_id":"call_1",
                "name":"echo",
                "arguments":"{}",
                "status":"completed"
            }
        ]
    });
    for process in ["chat", "direct"] {
        for stream in [false, true] {
            let wire = if stream {
                response_sse(&response)
            } else {
                response.to_string()
            };
            let (consumed, attempts) = refill_public_attempt(
                process,
                stream,
                &wire,
                json!({
                    "model":"test.test",
                    "input":"refill tool guard",
                    "stream":stream,
                    "tools":[{"type":"function","name":"echo","parameters":{"type":"object","properties":{}}}]
                }),
            )
            .await;
            assert_eq!(
                attempts, 1,
                "{process}/{stream}: a real tool call must stop refill: {consumed:?}"
            );
            assert!(
                consumed.transport_error.is_none(),
                "{process}/{stream}: tool-call business must deliver normally: {consumed:?}"
            );
            assert!(
                consumed.body.contains("call_1") && consumed.body.contains("echo"),
                "{process}/{stream}: tool identity must reach the client: {consumed:?}"
            );
            assert_no_error_payload(&consumed.body);
        }
    }
    std::env::remove_var(KEY_ENV);
}

/// A refill round that ends in a real tool call must hand the client a genuine
/// tool: complete arguments, real call ID and the real finish reason. The
/// client then executes it and sends the paired result back on a later request,
/// and the provider must receive that same call ID beside the original result.
///
/// Catches: a refill that fakes a tool, drops the call ID, or replays only the
/// last round's content into the next request's history.
#[tokio::test]
async fn refill_default_one_tool_roundtrip_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let first_round = refill_round_wire(false, "REFILL_BEFORE_TOOL");
    let tool_round = json!({
        "id":"resp_refill_tool",
        "object":"response",
        "status":"completed",
        "model":"wire-test",
        "output":[
            {
                "id":"fc_refill_weather",
                "type":"function_call",
                "call_id":"call_refill_weather",
                "name":"lookup_weather",
                "arguments":"{\"city\":\"Paris\"}",
                "status":"completed"
            }
        ]
    });
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        "chat",
        StatusCode::OK,
        "application/json",
        first_round.clone(),
        EntryOptions {
            attempt_bodies: vec![first_round.clone(), tool_round.to_string()],
            // The compiled default limit: original plus one refill.
            refill_max: None,
            ..EntryOptions::default()
        },
    )
    .await;
    let consumed = consume_response(
        client()
            .post(&endpoint)
            .json(&json!({
                "model":"test.test",
                "input":"weather check through a refill",
                "stream":false,
                "tools":[{"type":"function","name":"lookup_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]
            }))
            .send()
            .await,
    )
    .await;
    let attempts = std::iter::from_fn(|| captures.try_recv().ok()).count();
    stop_entry(handle, shutdown).await;
    assert_eq!(
        attempts, 2,
        "the default limit must produce exactly one refill: {consumed:?}"
    );
    assert!(
        consumed.transport_error.is_none(),
        "the refill chain must deliver: {consumed:?}"
    );
    assert_no_error_payload(&consumed.body);
    let delivered = client_responses_payload(&consumed.body);
    let call = delivered["output"]
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item["type"] == "function_call" && item["call_id"] == "call_refill_weather"
            })
        })
        .unwrap_or_else(|| panic!("refill tool call must reach the client: {delivered}"));
    assert_eq!(
        call["name"], "lookup_weather",
        "the real tool name must survive: {delivered}"
    );
    assert_eq!(
        call["arguments"], "{\"city\":\"Paris\"}",
        "complete arguments must survive: {delivered}"
    );
    assert!(
        consumed.body.contains("REFILL_BEFORE_TOOL"),
        "the prior round's business content must reach the client: {delivered}"
    );
    assert_eq!(
        delivered["status"], "completed",
        "the real terminal must be preserved: {delivered}"
    );
    let call_id = call["call_id"]
        .as_str()
        .unwrap_or_else(|| panic!("delivered call must carry an id: {call}"));

    // The client now executes the delivered tool itself. The executor is local
    // and deterministic, and its result is derived from the delivered
    // arguments: a dropped or rewritten argument changes the output.
    let executed_city: String = call["arguments"]
        .as_str()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|parsed| {
            parsed
                .get("city")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| panic!("delivered arguments must be complete JSON: {call}"));
    let client_tool_output = format!("weather for {executed_city}: sunny, 18C");

    // The follow-up request carries the delivered prior-round history verbatim
    // plus the real call and its real execution result.
    let completion = text_response("REFILL_TOOL_FOLLOWUP_DONE").to_string();
    let (endpoint2, handle2, mut captures2, _, shutdown2) = start_entry_configured(
        "responses",
        "chat",
        StatusCode::OK,
        "application/json",
        completion.clone(),
        EntryOptions {
            attempt_bodies: vec![completion],
            refill_max: None,
            ..EntryOptions::default()
        },
    )
    .await;
    let mut followup_input = vec![json!({
        "role":"user","content":"weather check through a refill"
    })];
    for item in delivered["output"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("message") => followup_input.push(json!({
                "type":"message","role":"assistant","content":item["content"].clone()
            })),
            Some("function_call") => followup_input.push(item.clone()),
            _ => {}
        }
    }
    followup_input.push(json!({
        "type":"function_call_output","call_id":call_id,"output":client_tool_output
    }));
    let (_, body2) = successful_transfer(
        client()
            .post(endpoint2)
            .json(&json!({ "model":"test.test", "input":followup_input }))
            .send()
            .await,
    )
    .await;
    assert!(body2.contains("REFILL_TOOL_FOLLOWUP_DONE"), "{body2}");
    let followup_wire = tokio::time::timeout(Duration::from_secs(2), captures2.recv())
        .await
        .expect("real upstream attempt")
        .unwrap();
    stop_entry(handle2, shutdown2).await;
    let items = followup_wire["input"]
        .as_array()
        .unwrap_or_else(|| panic!("provider must receive Responses input: {followup_wire}"));
    let call_item = items
        .iter()
        .find(|item| item["type"] == "function_call" && item["call_id"] == call_id)
        .unwrap_or_else(|| panic!("paired call missing: {followup_wire}"));
    assert_eq!(
        call_item["name"], "lookup_weather",
        "the paired call name must survive: {followup_wire}"
    );
    assert_eq!(
        call_item["arguments"], "{\"city\":\"Paris\"}",
        "the paired call arguments must survive: {followup_wire}"
    );
    let result_item = items
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
        .unwrap_or_else(|| panic!("paired result missing: {followup_wire}"));
    assert_eq!(
        result_item["output"], client_tool_output,
        "the client's real execution result must reach the provider: {followup_wire}"
    );
    std::env::remove_var(KEY_ENV);
}

/// Stable public ID: the refill budget is per request. Two concurrent requests
/// on one listener must each get the default limit, and an aborted client
/// request must not consume the other request's allowance.
#[tokio::test]
async fn refill_concurrent_cancel_public() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "responses",
        "chat",
        StatusCode::OK,
        "application/json",
        refill_round_wire(false, "CONCURRENT_R1"),
        EntryOptions {
            attempt_bodies: vec![
                refill_round_wire(false, "CONCURRENT_R1"),
                refill_round_wire(false, "CONCURRENT_R2"),
                refill_round_wire(false, "CONCURRENT_R1"),
                refill_round_wire(false, "CONCURRENT_R2"),
            ],
            // The compiled default limit applies to both requests.
            refill_max: None,
            ..EntryOptions::default()
        },
    )
    .await;
    // Two distinct requests. The marker stays in the request history, so every
    // provider attempt of one request can be attributed to that request.
    let survivor = tokio::spawn(
        client()
            .post(&endpoint)
            .json(&json!({
                "model":"test.test","input":"survivor-request-marker","stream":false
            }))
            .send(),
    );
    let cancelled = tokio::spawn(
        client()
            .post(&endpoint)
            .json(&json!({
                "model":"test.test","input":"cancelled-request-marker","stream":false
            }))
            .send(),
    );
    // Entry barrier: both requests must have reached the runtime and dispatched
    // a provider attempt before either is cancelled.
    let mut entered_survivor = false;
    let mut entered_cancelled = false;
    for _ in 0..2 {
        let wire = tokio::time::timeout(Duration::from_secs(30), captures.recv())
            .await
            .expect("both concurrent requests must enter the runtime")
            .expect("captured provider attempt");
        let text = wire.to_string();
        entered_survivor |= text.contains("survivor-request-marker");
        entered_cancelled |= text.contains("cancelled-request-marker");
    }
    assert!(
        entered_survivor && entered_cancelled,
        "both requests must reach the runtime before the cancellation"
    );
    cancelled.abort();
    let joined = tokio::time::timeout(Duration::from_secs(30), survivor)
        .await
        .expect("the survivor must not hang behind a cancelled sibling")
        .expect("join")
        .expect("survivor request");
    let status = joined.status();
    let survivor_body = joined.text().await.expect("body");
    // Give a cancelled request's in-flight refill a chance to surface before
    // the per-request attempt totals are compared.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut survivor_attempts = 0;
    let mut cancelled_attempts = 0;
    while let Ok(wire) = captures.try_recv() {
        let text = wire.to_string();
        if text.contains("cancelled-request-marker") {
            cancelled_attempts += 1;
        } else if text.contains("survivor-request-marker") {
            survivor_attempts += 1;
        }
    }
    stop_entry(handle, shutdown).await;
    assert_eq!(status, StatusCode::OK, "{survivor_body}");
    let survivor_messages = client_responses_payload(&survivor_body)["output"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| item["type"] == "message")
                .count()
        })
        .unwrap_or(0);
    assert_eq!(
        survivor_messages, 2,
        "the survivor must deliver both its original and refill rounds: {survivor_body}"
    );
    assert_eq!(
        survivor_attempts, 1,
        "the survivor must use exactly its own remaining default budget after the barrier attempt: {survivor_body}"
    );
    assert!(
        cancelled_attempts <= 1,
        "the cancelled request must not run more refills than its own budget: {cancelled_attempts}"
    );
    assert!(
        !survivor_body.contains("provider_response_empty"),
        "no sibling cancellation may surface as a client error: {survivor_body}"
    );

    // Cross-listener isolation: two independent servers each grant the full
    // default refill, so the budget is neither shared nor duplicated.
    for marker in ["left-listener-marker", "right-listener-marker"] {
        let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
            "responses",
            "chat",
            StatusCode::OK,
            "application/json",
            refill_round_wire(false, "CROSS_R1"),
            EntryOptions {
                attempt_bodies: vec![
                    refill_round_wire(false, "CROSS_R1"),
                    refill_round_wire(false, "CROSS_R2"),
                ],
                refill_max: None,
                ..EntryOptions::default()
            },
        )
        .await;
        let consumed = consume_response(
            client()
                .post(&endpoint)
                .json(&json!({"model":"test.test","input":marker,"stream":false}))
                .send()
                .await,
        )
        .await;
        let attempts = std::iter::from_fn(|| captures.try_recv().ok()).count();
        stop_entry(handle, shutdown).await;
        assert_eq!(
            attempts, 2,
            "{marker}: each listener must grant the full default budget: {consumed:?}"
        );
        assert!(
            consumed.body.contains("CROSS_R1") && consumed.body.contains("CROSS_R2"),
            "{marker}: both rounds must be delivered: {consumed:?}"
        );
        assert_no_error_payload(&consumed.body);
    }
    std::env::remove_var(KEY_ENV);
}

/// db1f482 public-entry regression: an HTTP 200 OpenAI Chat SSE head with one
/// partial business delta and no semantic terminal is a typed provider
/// transport failure. The last eligible exact identity must stay health-neutral,
/// and the client must see only a detectable termination with no provider error
/// payload or fabricated success.
async fn assert_public_execution_mode(base: &str, expected_mode: &str) {
    let logs: Value = client()
        .get(format!("{base}/_routecodex/debug/logs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let events: Vec<&Value> = logs["logs"]
        .as_array()
        .unwrap_or_else(|| panic!("debug logs must return events: {logs}"))
        .iter()
        .filter(|event| {
            event["node_id"] == "V3Server03HttpRequestRaw"
                && event["event"] == "received"
                && event["details"]["path"] == "/v1/chat/completions"
        })
        .collect();
    assert_eq!(
        events.len(),
        1,
        "public request must enter exactly once with its actual mode: {logs}"
    );
    assert_eq!(
        events[0]["details"]["execution_mode"], expected_mode,
        "public request executed outside the selected mode: {}",
        events[0]
    );
}

async fn db1f482_truncated_openai_chat_sse_public_case(execution_mode: &str, content: &str) {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let partial = format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_truncated",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "wire-test",
            "choices": [{
                "index": 0,
                "delta": {"content": "partial"},
                "finish_reason": null
            }]
        })
    );
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "openai_chat",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        partial.clone(),
        EntryOptions {
            health_enabled: true,
            attempt_bodies: vec![partial],
            auth_entries: vec![("key1".into(), KEY_ENV.into())],
            pin_key: Some("key1".into()),
            execution_mode: Some(execution_mode.to_string()),
            ..EntryOptions::default()
        },
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let consumed = consume_response(
        client()
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({
                "model": "test.test",
                "messages": [{"role": "user", "content": content}],
                "stream": true
            }))
            .send()
            .await,
    )
    .await;
    assert!(
        consumed.transport_error.is_some(),
        "{execution_mode}: truncated stream must terminate detectably: {consumed:?}"
    );
    assert!(
        consumed.status.is_none() || consumed.status == Some(StatusCode::OK),
        "{execution_mode}: no client HTTP error number: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("[DONE]"),
        "{execution_mode}: no fabricated terminal: {consumed:?}"
    );
    assert!(
        !consumed.body.contains("\"finish_reason\":\"stop\""),
        "{execution_mode}: no fabricated success: {consumed:?}"
    );
    assert_no_error_payload(&consumed.body);
    assert_public_execution_mode(base, execution_mode).await;

    let health: Value = client()
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entries = health["entries"].as_array().unwrap();
    assert!(
        !entries.iter().any(|row| {
            row["provider_id"] == "test" && row["auth_alias"] == "key1" && row["model_id"] == "test"
        }),
        "{execution_mode}: last-candidate truncated HTTP 200 must stay health-neutral: {health}"
    );
    stop_entry(handle, shutdown).await;
    let mut attempts = 0;
    while let Some(capture) = captures.recv().await {
        if capture.to_string().contains(content) {
            attempts += 1;
        }
    }
    assert_eq!(
        attempts, 1,
        "{execution_mode}: the single candidate must be attempted exactly once before terminal"
    );
    std::env::remove_var(KEY_ENV);
}

#[tokio::test]
async fn db1f482_truncated_openai_chat_sse_keeps_last_candidate_health_neutral_at_public_entry() {
    db1f482_truncated_openai_chat_sse_public_case("direct", "db1f482 truncated 200 direct").await;
}

#[tokio::test]
async fn db1f482_truncated_openai_chat_sse_relay_keeps_last_candidate_health_neutral_at_public_entry(
) {
    db1f482_truncated_openai_chat_sse_public_case("relay", "db1f482 truncated 200 relay").await;
}

#[tokio::test]
async fn db1f482_relay_client_disconnect_keeps_candidate_health_neutral_at_public_entry() {
    // Server cancellation coverage: dropping the committed SSE body aborts the
    // runtime outcome task in V3ClientSseChannelStream::drop. This path does not
    // feed V3ProviderError::ClientDisconnect through the protocol codec or relay
    // collector; the typed collector handoff and its untyped counterexample are
    // covered by the runtime integration test.
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var(KEY_ENV, "controlled-secret");
    let partial = format!(
        "data: {}\n\n",
        json!({
            "id": "chatcmpl_client_disconnect",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "wire-test",
            "choices": [{
                "index": 0,
                "delta": {"content": "partial before disconnect"},
                "finish_reason": null
            }]
        })
    );
    let (endpoint, handle, mut captures, _, shutdown) = start_entry_configured(
        "openai_chat",
        "chat",
        StatusCode::OK,
        "text/event-stream",
        partial.clone(),
        EntryOptions {
            health_enabled: true,
            attempt_bodies: vec![partial],
            auth_entries: vec![("key1".into(), KEY_ENV.into())],
            pin_key: Some("key1".into()),
            execution_mode: Some("relay".into()),
            hold_attempt_open: true,
            ..EntryOptions::default()
        },
    )
    .await;
    let base = endpoint.trim_end_matches("/v1/responses");
    let response = client()
        .post(format!("{base}/v1/chat/completions"))
        .json(&json!({
            "model": "test.test",
            "messages": [{"role": "user", "content": "db1f482 relay client disconnect"}],
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let first = tokio::time::timeout(Duration::from_secs(2), captures.recv())
        .await
        .expect("provider request must start before the client disconnects")
        .expect("provider capture channel must remain open");
    assert!(
        first
            .to_string()
            .contains("db1f482 relay client disconnect"),
        "unexpected provider request: {first}"
    );

    drop(response);
    let preparation = tokio::time::timeout(Duration::from_secs(5), handle.prepare_exec_attempt())
        .await
        .expect("client cancellation leaked active runtime work")
        .unwrap();
    drop(preparation);
    assert!(
        tokio::time::timeout(Duration::from_millis(250), captures.recv())
            .await
            .is_err(),
        "client disconnect must not start another provider attempt"
    );
    assert_public_execution_mode(base, "relay").await;
    let health: Value = client()
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entries = health["entries"].as_array().unwrap();
    assert!(
        !entries.iter().any(|row| {
            row["provider_id"] == "test" && row["auth_alias"] == "key1" && row["model_id"] == "test"
        }),
        "client disconnect must stay health-neutral: {health}"
    );
    stop_entry(handle, shutdown).await;
    std::env::remove_var(KEY_ENV);
}
