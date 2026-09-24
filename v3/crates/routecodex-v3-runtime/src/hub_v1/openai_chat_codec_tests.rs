// openai_chat_codec tests, split from openai_chat_codec.rs to satisfy
// verify:v3-file-size ratchet. Semantics unchanged: this module is the direct
// child of openai_chat_codec, so `use super::*` resolves identically to the
// former inline `mod openai_chat_responses_sse_transducer_tests`.

use super::*;
use serde_json::json;

fn created_event() -> Value {
    json!({
        "type": "response.created",
        "response": {
            "id": "resp_test_1",
            "status": "in_progress",
            "model": "gpt-5.6-sol"
        }
    })
}

fn in_progress_event() -> Value {
    json!({
        "type": "response.in_progress",
        "response": {
            "id": "resp_test_1",
            "status": "in_progress"
        }
    })
}

fn delta_event(text: &str) -> Value {
    json!({"type": "response.output_text.delta", "delta": text})
}

#[test]
fn transducer_accepts_official_created_then_in_progress_sequence() {
    let mut with_in_progress = V3OpenAiChatResponsesSseTransducer::new();
    let created_chunks = with_in_progress
        .push_event(created_event())
        .expect("created");
    let progress_chunks = with_in_progress
        .push_event(in_progress_event())
        .expect("official response.in_progress after response.created must not be rejected");
    let delta_chunks = with_in_progress
        .push_event(delta_event("hello"))
        .expect("delta");
    with_in_progress
        .push_event(json!({"type": "response.completed", "response": {"id": "resp_test_1"}}))
        .expect("completed");
    with_in_progress.finish().expect("finish");

    let mut without_in_progress = V3OpenAiChatResponsesSseTransducer::new();
    let baseline_created = without_in_progress
        .push_event(created_event())
        .expect("created");
    let baseline_delta = without_in_progress
        .push_event(delta_event("hello"))
        .expect("delta");
    without_in_progress
        .push_event(json!({"type": "response.completed", "response": {"id": "resp_test_1"}}))
        .expect("completed");
    without_in_progress.finish().expect("finish");

    assert_eq!(
        created_chunks
            .iter()
            .cloned()
            .chain(progress_chunks.iter().cloned())
            .chain(delta_chunks.iter().cloned())
            .collect::<Vec<_>>(),
        baseline_created
            .iter()
            .cloned()
            .chain(baseline_delta.iter().cloned())
            .collect::<Vec<_>>(),
        "response.in_progress must be idempotent and emit no extra chunk"
    );
}

#[test]
fn transducer_still_rejects_duplicate_created() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer
        .push_event(created_event())
        .expect("first created");
    let error = transducer
        .push_event(created_event())
        .expect_err("a genuinely duplicate response.created must still fail fast");
    assert!(
        error.contains("duplicate response.created"),
        "unexpected error: {error}"
    );
}

#[test]
fn transducer_in_progress_without_created_starts_response() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    let chunks = transducer
        .push_event(in_progress_event())
        .expect("response.in_progress as first event must start the response");
    assert_eq!(
        chunks.len(),
        1,
        "in_progress start must emit the assistant role chunk"
    );
}

#[test]
fn transducer_accepts_known_responses_lifecycle_events() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    for event_type in [
        "response.content_part.added",
        "response.content_part.done",
        "response.output_text.done",
        "response.output_text.annotation.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
    ] {
        let chunks = transducer
            .push_event(json!({"type": event_type}))
            .expect("known Responses lifecycle event must be accepted");
        assert!(chunks.is_empty(), "{event_type} must not emit a Chat chunk");
    }
    transducer.push_event(delta_event("hello")).expect("delta");
    transducer
        .push_event(json!({
            "type": "response.completed",
            "response": {"id": "resp_test_1", "status": "completed"}
        }))
        .expect("completed");
    transducer.finish().expect("finish");
}

#[test]
fn responses_usage_is_a_separate_chat_sse_chunk_without_choices() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    transducer.push_event(delta_event("OK")).expect("delta");
    let chunks = transducer
        .push_event(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_test_1",
                "status": "completed",
                "usage": {"input_tokens": 12, "output_tokens": 2}
            }
        }))
        .expect("completed");
    assert_eq!(
        chunks.len(),
        2,
        "finish and usage need distinct Chat chunks"
    );
    assert_eq!(chunks[0]["choices"][0]["finish_reason"], "stop");
    assert!(chunks[0].get("usage").is_none());
    assert_eq!(chunks[1]["choices"], json!([]));
    assert_eq!(
        chunks[1]["usage"],
        json!({
            "prompt_tokens": 12,
            "completion_tokens": 2,
            "total_tokens": 14
        })
    );
}

#[test]
fn responses_function_call_finishes_with_tool_calls_before_usage() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    let call = transducer
        .push_event(json!({
            "type": "response.output_item.done",
            "item": {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": "{\"q\":\"alpha\"}"}
        }))
        .expect("function call");
    assert_eq!(
        call[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
        "{\"q\":\"alpha\"}"
    );
    let terminal = transducer
        .push_event(json!({"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 4, "output_tokens": 2}}}))
        .expect("completed");
    assert_eq!(terminal[0]["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(terminal[1]["choices"], json!([]));
    transducer.finish().expect("complete tool call");
}

#[test]
fn responses_usage_is_not_sent_when_chat_client_opts_out() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new_with_usage_option(false);
    transducer.push_event(created_event()).expect("created");
    transducer.push_event(delta_event("OK")).expect("delta");
    let chunks = transducer
        .push_event(json!({"type": "response.completed", "response": {"status": "completed", "usage": {"input_tokens": 3, "output_tokens": 1}}}))
        .expect("completed");
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0]["choices"][0]["finish_reason"], "stop");
    assert!(chunks[0].get("usage").is_none());
}

#[test]
fn transducer_maps_max_output_tokens_incomplete_to_length_terminal_chunk() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    transducer
        .push_event(json!({
            "type": "response.reasoning_text.delta",
            "delta": "thinking"
        }))
        .expect("reasoning delta");
    let chunks = transducer
        .push_event(json!({
            "type": "response.incomplete",
            "response": {
                "id": "resp_test_1",
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "usage": {
                    "input_tokens": 42,
                    "output_tokens": 7,
                    "total_tokens": 49
                }
            }
        }))
        .expect("response.incomplete must project a terminal Chat chunk");
    assert_eq!(chunks.len(), 2);
    let terminal = &chunks[0];
    assert_eq!(
        terminal["choices"][0]["finish_reason"],
        json!("length"),
        "max_output_tokens truncation must map to finish_reason=length: {terminal}"
    );
    assert_eq!(
        chunks[1]["usage"]["prompt_tokens"],
        json!(42),
        "usage chunk must carry normalized usage: {}",
        chunks[1]
    );
    assert_eq!(chunks[1]["choices"], json!([]));
    transducer
        .finish()
        .expect("finish accepts incomplete terminal");
}

#[test]
fn transducer_maps_content_filter_incomplete_to_content_filter_terminal_chunk() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    let chunks = transducer
        .push_event(json!({
            "type": "response.incomplete",
            "incomplete_details": {"reason": "content_filter"},
            "response": {
                "id": "resp_test_1",
                "status": "incomplete"
            }
        }))
        .expect("response.incomplete must project a terminal Chat chunk");
    assert_eq!(chunks.len(), 1);
    assert_eq!(
        chunks[0]["choices"][0]["finish_reason"],
        json!("content_filter")
    );
    transducer
        .finish()
        .expect("finish accepts incomplete terminal");
}

#[test]
fn transducer_rejects_incomplete_without_or_unknown_reason() {
    for payload in [
        json!({
            "type": "response.incomplete",
            "response": {"id": "resp_test_1", "status": "incomplete"}
        }),
        json!({
            "type": "response.incomplete",
            "incomplete_details": {"reason": "internal_error"},
            "response": {"id": "resp_test_1", "status": "incomplete"}
        }),
    ] {
        let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
        transducer.push_event(created_event()).expect("created");
        let error = transducer
            .push_event(payload)
            .expect_err("malformed/unknown incomplete terminal must fail fast");
        assert!(
            error.contains("response.incomplete"),
            "unexpected error: {error}"
        );
    }
}

// Issue #2: the openai_chat outbound response must preserve tool-call
// pairing. A canonical Responses tool item is keyed by `call_id`, but some
// providers only carry `id` (and vice versa); reading only `call_id` with
// `unwrap_or_default()` produces an empty `tool_calls[].id`, which makes the
// next turn's `tool_call_id` an orphan.
#[test]
fn transducer_resolves_tool_call_identity_from_item_id() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    let chunks = transducer
        .push_event(json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "id": "fc_item_only",
                "name": "lookup",
                "arguments": "{\"q\":\"alpha\"}"
            }
        }))
        .expect("output_item.done with only item.id must project");
    let tool_call = chunks
        .iter()
        .find_map(|chunk| chunk.pointer("/choices/0/delta/tool_calls/0"))
        .expect("tool_call chunk");
    assert_eq!(
        tool_call["id"],
        json!("fc_item_only"),
        "tool_calls[].id must resolve from item.id, never empty: {chunks:?}"
    );
    assert_eq!(tool_call["function"]["name"], json!("lookup"));
}

#[test]
fn transducer_ignores_present_but_empty_call_id_before_using_item_id() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    let chunks = transducer
        .push_event(json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "   ",
                "id": "fc_item_only",
                "name": "lookup",
                "arguments": "{}"
            }
        }))
        .expect("output_item.done must project");
    let tool_call = chunks
        .iter()
        .find_map(|chunk| chunk.pointer("/choices/0/delta/tool_calls/0"))
        .expect("tool_call chunk");
    assert_eq!(
        tool_call["id"],
        json!("fc_item_only"),
        "an empty call_id must not win over a non-empty id: {chunks:?}"
    );
}

// Issue #2: `custom_tool_call` items must also project, otherwise the
// assistant turn that requested a custom tool loses its tool_call and the
// follow-up `tool_call_id` becomes an orphan.
#[test]
fn transducer_projects_custom_tool_call_items() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    let chunks = transducer
        .push_event(json!({
            "type": "response.output_item.done",
            "item": {
                "type": "custom_tool_call",
                "call_id": "call_custom_1",
                "name": "apply_patch",
                "input": "*** Begin Patch"
            }
        }))
        .expect("custom_tool_call must project");
    let tool_call = chunks
        .iter()
        .find_map(|chunk| chunk.pointer("/choices/0/delta/tool_calls/0"))
        .expect("custom_tool_call must emit a tool_call chunk");
    assert_eq!(tool_call["id"], json!("call_custom_1"));
    assert_eq!(tool_call["function"]["name"], json!("apply_patch"));
    assert_eq!(
        tool_call["function"]["arguments"],
        json!("*** Begin Patch"),
        "custom_tool_call.input must project into function.arguments"
    );
}

// Issue #2: the non-stream projection must apply the same identity resolution
// and custom_tool_call projection.
#[test]
fn non_stream_projection_resolves_item_id_and_projects_custom_tool_call() {
    let projected = project_v3_openai_chat_client_response_from_canonical(&json!({
        "status": "completed",
        "output": [
            {
                "type": "function_call",
                "id": "fc_item_only",
                "name": "lookup",
                "arguments": "{\"q\":\"alpha\"}"
            },
            {
                "type": "custom_tool_call",
                "call_id": "call_custom_1",
                "name": "apply_patch",
                "input": "*** Begin Patch"
            }
        ]
    }))
    .expect("canonical tool items must project");
    let tool_calls = projected["choices"][0]["message"]["tool_calls"]
        .as_array()
        .expect("tool_calls array");
    assert_eq!(tool_calls.len(), 2, "{projected}");
    assert_eq!(tool_calls[0]["id"], json!("fc_item_only"));
    assert_eq!(tool_calls[0]["function"]["name"], json!("lookup"));
    assert_eq!(tool_calls[1]["id"], json!("call_custom_1"));
    assert_eq!(tool_calls[1]["function"]["name"], json!("apply_patch"));
    assert_eq!(
        tool_calls[1]["function"]["arguments"],
        json!("*** Begin Patch")
    );
    assert_eq!(
        projected["choices"][0]["finish_reason"],
        json!("tool_calls")
    );
}

// Issue #2: the helper's middle `tool_call_id` key must resolve too.
#[test]
fn transducer_resolves_tool_call_identity_from_tool_call_id() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    let chunks = transducer
        .push_event(json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "tool_call_id": "call_from_tool_call_id",
                "name": "lookup",
                "arguments": "{}"
            }
        }))
        .expect("output_item.done must project");
    let tool_call = chunks
        .iter()
        .find_map(|chunk| chunk.pointer("/choices/0/delta/tool_calls/0"))
        .expect("tool_call chunk");
    assert_eq!(tool_call["id"], json!("call_from_tool_call_id"));
}

// Issue #2: when the provider supplies no identity at all the projection must
// not silently invent one; it emits an empty id which request-side governance
// rejects explicitly (no fabrication). This pins the documented residual case.
#[test]
fn transducer_emits_empty_id_when_no_identity_is_supplied() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    let chunks = transducer
        .push_event(json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "name": "lookup",
                "arguments": "{}"
            }
        }))
        .expect("output_item.done must project");
    let tool_call = chunks
        .iter()
        .find_map(|chunk| chunk.pointer("/choices/0/delta/tool_calls/0"))
        .expect("tool_call chunk");
    assert_eq!(
        tool_call["id"],
        json!(""),
        "a provider with no identity yields an empty id, never a fabricated one: {chunks:?}"
    );
}

// Issue #2 / M2: the stream terminal must report finish_reason=tool_calls when
// a tool call was emitted, matching the non-stream projection; otherwise a
// client that gates tool execution on finish_reason never runs the tool.
#[test]
fn transducer_reports_tool_calls_finish_reason_after_tool_call_item() {
    let mut transducer = V3OpenAiChatResponsesSseTransducer::new();
    transducer.push_event(created_event()).expect("created");
    transducer
        .push_event(json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_1",
                "name": "lookup",
                "arguments": "{}"
            }
        }))
        .expect("tool call item");
    let terminal = transducer
        .push_event(json!({
            "type": "response.completed",
            "response": {"id": "resp_test_1", "status": "completed"}
        }))
        .expect("completed");
    let finish_reason = terminal
        .iter()
        .find_map(|chunk| chunk.pointer("/choices/0/finish_reason"))
        .expect("terminal finish_reason");
    assert_eq!(
        finish_reason,
        &json!("tool_calls"),
        "stream terminal after a tool call must be finish_reason=tool_calls: {terminal:?}"
    );
}
