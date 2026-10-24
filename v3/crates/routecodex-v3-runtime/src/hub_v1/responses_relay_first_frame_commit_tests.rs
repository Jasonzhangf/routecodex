//! Relay first-frame commit gates (P2).
//!
//! These gates bind the Relay client projection to one failure mode: a Responses
//! client that asked for SSE must receive the first visible output text while the
//! provider stream is still open, instead of the whole answer at the provider
//! terminal. They call the projection owner directly, so a failure names that
//! owner and not the transport.

use super::*;
use serde_json::json;

fn relay_test_budget() -> crate::nodes::V3AttemptBudget {
    let manifest = super::responses_relay_runtime_tests::anthropic_then_openai_chat_manifest();
    crate::nodes::V3RequestExecutionControl::from_manifest(&manifest, "test")
        .expect("execution control")
        .attempt_budget()
}

fn drain_frames(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) -> Vec<String> {
    let mut frames = Vec::new();
    while let Ok(frame) = receiver.try_recv() {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    frames
}

#[test]
fn relay_first_frame_commit_projects_text_before_provider_terminal() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    // First provider increment carries visible text. The provider stream is still
    // open: no terminal was consumed yet.
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_relay_first_frame",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "he"}}],
        }))
        .expect("first chat increment must project");

    assert!(
        projector.is_committed(),
        "visible output text must commit the Relay client stream before the provider terminal"
    );
    let frames = drain_frames(&mut receiver);
    assert!(
        frames
            .iter()
            .any(|frame| frame.contains("response.output_text.delta") && frame.contains("he")),
        "the committed channel must already carry the first text delta, got {frames:?}"
    );
    assert!(
        !frames
            .iter()
            .any(|frame| frame.contains("response.completed")),
        "the terminal frame must stay held until the attempt seals, got {frames:?}"
    );
}

#[tokio::test]
async fn relay_first_frame_commit_holds_tool_arguments_until_the_item_completes() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_relay_tool",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0,
                "id": "call_relay_1",
                "type": "function",
                "function": {"name": "read_file", "arguments": "{\"pa"}
            }]}}],
        }))
        .expect("named tool call must project its start");
    assert!(
        projector.is_committed(),
        "a named tool-call start must commit the Relay client stream"
    );
    let frames = drain_frames(&mut receiver);
    assert!(
        frames
            .iter()
            .any(|frame| frame.contains("response.output_item.added")),
        "the tool-call start frame must reach the client, got {frames:?}"
    );
    assert!(
        !frames
            .iter()
            .any(|frame| frame.contains("function_call_arguments")),
        "tool argument bytes must stay gated until the item completes, got {frames:?}"
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_relay_tool",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"tool_calls": [{
                "index": 0,
                "function": {"arguments": "th\":1}"}
            }]}, "finish_reason": "tool_calls"}],
        }))
        .expect("second tool increment");
    let terminal = json!({
        "id": "chatcmpl_relay_tool",
        "status": "completed",
        "output": [{
            "id": "call_relay_1",
            "type": "function_call",
            "call_id": "call_relay_1",
            "name": "read_file",
            "arguments": "{\"path\":1}"
        }],
    });
    let mut sealed = projector
        .finish(&terminal)
        .expect("seal the committed stream");
    let mut tail = String::new();
    use futures_util::StreamExt;
    while let Some(frame) = sealed.next().await {
        tail.push_str(&String::from_utf8_lossy(&frame));
    }
    let frames = drain_frames(&mut receiver);
    let all = format!("{}{}", frames.join(""), tail);
    assert!(
        all.contains("\"arguments\":\"{\\\"path\\\":1}\""),
        "the completed item must carry the whole argument payload, got {all}"
    );
    assert!(
        all.contains("response.completed"),
        "the sealed tail must close the response, got {all}"
    );
}

/// A refill is a separate provider response. The delivered payload keeps its
/// items apart, so the client must receive one business item per round instead
/// of one item that silently merges two rounds.
#[tokio::test]
async fn relay_refill_round_boundary_opens_a_new_business_item() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_round_one",
            "model": "wire-test",
            "created": 1,
            "choices": [{"index": 0, "delta": {"content": "first"}, "finish_reason": null}],
        }))
        .expect("round one chunk");
    projector.close_round().expect("close round one");

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_round_two",
            "model": "wire-test",
            "created": 2,
            "choices": [{"index": 0, "delta": {"content": "second"}, "finish_reason": null}],
        }))
        .expect("round two chunk");

    let terminal = json!({
        "id": "chatcmpl_round_two",
        "object": "response",
        "status": "completed",
        "output": [
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "first"}]},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "second"}]}
        ],
    });
    let mut sealed = projector.finish(&terminal).expect("seal");
    let mut frames = drain_frames(&mut receiver);
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    // Two rounds must produce two announcements and two donations, not one.
    let added = frames
        .iter()
        .filter(|frame| frame.contains("response.output_item.added"))
        .count();
    assert_eq!(added, 2, "each round announces its own item: {frames:?}");
    let done: Vec<&String> = frames
        .iter()
        .filter(|frame| frame.contains("response.output_item.done"))
        .collect();
    assert_eq!(done.len(), 2, "each round closes its own item: {frames:?}");
    // The first round's text must not be rewritten by the second round.
    assert!(
        done[0].contains("\"text\":\"first\""),
        "round one keeps its own text: {}",
        done[0]
    );
    assert!(
        done[1].contains("\"text\":\"second\""),
        "round two keeps its own text: {}",
        done[1]
    );
    // The terminal names both streamed items and the response the client saw.
    let terminal_frame = frames
        .iter()
        .find(|frame| frame.contains("response.completed"))
        .expect("terminal frame");
    assert!(
        terminal_frame.contains("\"id\":\"msg_0\"") && terminal_frame.contains("\"id\":\"msg_1\""),
        "terminal reuses both streamed item ids: {terminal_frame}"
    );
    assert!(
        terminal_frame.contains("chatcmpl_round_one"),
        "terminal keeps the response id the client already received: {terminal_frame}"
    );
}
