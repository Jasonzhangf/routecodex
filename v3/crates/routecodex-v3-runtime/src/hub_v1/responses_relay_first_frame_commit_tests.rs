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

/// A trailing marker prefix is ordinary text once the provider stream ends. The
/// committed projector must keep it (and the bytes that resolve it) instead of
/// truncating the attempt. A complete governed marker after the commit is the
/// one case the attempt owner cannot preserve, so the transport breaks visibly
/// without a completed terminal.
#[tokio::test]
async fn relay_committed_marker_prefix_releases_tail_but_real_marker_breaks() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_marker_tail",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "answer "}, "finish_reason": null}],
        }))
        .expect("committed text chunk");
    assert!(
        projector.is_committed(),
        "the first text must commit the stream"
    );
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_marker_tail",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "<"}, "finish_reason": null}],
        }))
        .expect("marker prefix chunk");
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_marker_tail",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "= 3"}, "finish_reason": null}],
        }))
        .expect("tail-resolving chunk");

    let terminal = json!({
        "id": "chatcmpl_marker_tail",
        "object": "response",
        "status": "completed",
        "output": [{"type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "answer <= 3"}]}],
    });
    let mut sealed = projector
        .finish(&terminal)
        .expect("tail must seal normally");
    let mut frames = drain_frames(&mut receiver);
    use futures_util::StreamExt;
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    let all = frames.join("");
    assert!(
        all.contains("answer <= 3") && all.contains("response.completed"),
        "the resolved tail must be delivered with a normal completed terminal, got {all}"
    );

    // Real governed marker: the same committed prefix followed by a complete
    // DSML close label on its own line. The attempt owner cannot preserve those
    // bytes, so the projector must end the transport before any completed frame.
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_marker_break",
            "object": "chat.completion.chunk",
            "created": 2,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "answer "}, "finish_reason": null}],
        }))
        .expect("committed text chunk");
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_marker_break",
            "object": "chat.completion.chunk",
            "created": 2,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "\n</｜DSML｜tool_calls>"}, "finish_reason": null}],
        }))
        .expect("governed marker chunk");

    let terminal = json!({
        "id": "chatcmpl_marker_break",
        "object": "response",
        "status": "completed",
        "output": [{"type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "answer"}]}],
    });
    let broken = projector
        .finish(&terminal)
        .expect_err("a committed real marker must break the transport");
    assert!(
        broken.contains("governed"),
        "the break error must name the governed marker, got {broken}"
    );
    assert!(
        !drain_frames(&mut receiver)
            .iter()
            .any(|frame| frame.contains("response.completed")),
        "no completed terminal may reach the client after the break"
    );
}

/// A committed stream keeps the bytes it already sent. Chat Process rewrites the
/// provider payload after this projection, so the terminal must repeat the
/// announced items rather than re-describe the provider payload.
#[tokio::test]
async fn relay_committed_terminal_repeats_announced_items_after_governance() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    // The provider streams visible text while its stream is still open.
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_governed",
            "model": "wire-test",
            "created": 7,
            "choices": [{"index": 0, "delta": {"content": "plain answer"}, "finish_reason": null}],
        }))
        .expect("chunk");

    // The terminal payload is the post-governance shape: the think block was
    // harvested into a leading reasoning item and the visible text was rewritten.
    let terminal = json!({
        "id": "chatcmpl_governed",
        "object": "response",
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "hidden plan"}],
             "content": [{"type": "reasoning_text", "text": "hidden plan"}]},
            {"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": "plain answer"}]}
        ],
    });
    let mut sealed = projector.finish(&terminal).expect("seal");
    let mut frames = drain_frames(&mut receiver);
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }

    // The client never saw the leading reasoning item, so the terminal must not
    // introduce one: it would be a second, unreconciled description of the same
    // answer.
    let terminal_frame = frames
        .iter()
        .find(|frame| frame.contains("response.completed"))
        .expect("terminal frame");
    assert!(
        !terminal_frame.contains("reasoning"),
        "terminal introduces an item the client never received: {terminal_frame}"
    );
    assert!(
        terminal_frame.contains("\"text\":\"plain answer\"") && terminal_frame.contains("msg_0"),
        "terminal repeats the announced item exactly: {terminal_frame}"
    );
    // The announced item stays one business item in the terminal output array.
    assert_eq!(
        terminal_frame.matches("\"type\":\"message\"").count(),
        1,
        "terminal output carries exactly the announced item: {terminal_frame}"
    );
}

/// Items close in arrival order but the protocol orders `output` by output
/// index. A long message interleaved with reasoning items must not reorder the
/// terminal payload.
#[tokio::test]
async fn relay_terminal_output_follows_output_index_not_close_order() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    // reasoning rs_0 -> message msg_1 (closes rs_0) -> reasoning rs_2
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_order", "model": "wire-test", "created": 1,
            "choices": [{"index": 0, "delta": {"reasoning_content": "r1"}, "finish_reason": null}],
        }))
        .expect("reasoning one");
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_order", "model": "wire-test", "created": 1,
            "choices": [{"index": 0, "delta": {"content": "answer"}, "finish_reason": null}],
        }))
        .expect("message");
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_order", "model": "wire-test", "created": 1,
            "choices": [{"index": 0, "delta": {"reasoning_content": "r2"}, "finish_reason": null}],
        }))
        .expect("reasoning two");

    let terminal = json!({
        "id": "chatcmpl_order", "object": "response", "status": "completed",
        "output": [
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "r1"}]},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "answer"}]},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "r2"}]}
        ],
    });
    let mut sealed = projector.finish(&terminal).expect("seal");
    let mut frames = drain_frames(&mut receiver);
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    let terminal_frame = frames
        .iter()
        .find(|frame| frame.contains("response.completed"))
        .expect("terminal frame");
    let ids = ["rs_0", "msg_1", "rs_2"];
    let positions: Vec<usize> = ids
        .iter()
        .map(|id| {
            terminal_frame
                .find(&format!("\"id\":\"{id}\""))
                .unwrap_or_else(|| panic!("terminal keeps {id}: {terminal_frame}"))
        })
        .collect();
    assert!(
        positions[0] < positions[1] && positions[1] < positions[2],
        "terminal output follows output index order, got {positions:?}: {terminal_frame}"
    );
}

/// Chat Process rewrites the business carriers of every request that declares a
/// tool, so such a request must keep whole-attempt buffering. A Responses client
/// can declare tools three ways: a top-level field, an `additional_tools` input
/// item, or a `tool_search_output` input item.
#[test]
fn relay_tool_declaration_blocks_first_frame_commit_from_every_source() {
    let custom = json!({"type": "custom", "name": "exec"});
    let declares = |payload: Value| {
        super::responses_relay_runtime_inner::relay_request_declares_tools(&payload)
    };

    assert!(declares(json!({"tools": [custom]})));
    assert!(declares(json!({"additional_tools": [custom]})));
    assert!(declares(json!({
        "input": [{"type": "additional_tools", "tools": [custom]}]
    })));
    assert!(declares(json!({
        "input": [{"type": "tool_search_output", "tools": [custom]}]
    })));
    // A tool-free request still commits, otherwise the feature is dead.
    assert!(!declares(
        json!({"input": [{"type": "message", "content": "hi"}]})
    ));
    assert!(!declares(json!({"tools": []})));
}

/// Reasoning may arrive as `reasoning.summary[]`, not only the legacy
/// `reasoning_content` string. The projector must turn it into the same
/// Responses reasoning item and include it in the terminal output.
#[tokio::test]
async fn relay_first_frame_commit_projects_reasoning_summary_before_terminal() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_reasoning_summary",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "answer"}, "finish_reason": null}],
        }))
        .expect("text chunk");
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_reasoning_summary",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"reasoning": {
                "summary": [{"type": "summary_text", "text": "private plan"}]
            }}, "finish_reason": null}],
        }))
        .expect("reasoning summary chunk");

    let terminal = json!({
        "id": "chatcmpl_reasoning_summary",
        "object": "response",
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "private plan"}]},
            {"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": "answer"}]}
        ],
    });
    let mut sealed = projector.finish(&terminal).expect("seal");
    let mut frames = drain_frames(&mut receiver);
    use futures_util::StreamExt;
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    assert!(
        frames.iter().any(
            |frame| frame.contains("response.reasoning_summary_text.delta")
                && frame.contains("private plan")
        ),
        "reasoning.summary[] must become a client-visible reasoning delta: {frames:?}"
    );
    let terminal_frame = frames
        .iter()
        .find(|frame| frame.contains("response.completed"))
        .expect("terminal frame");
    assert!(
        terminal_frame.contains("\"type\":\"reasoning\"")
            && terminal_frame.contains("\"private plan\""),
        "terminal must include the streamed reasoning item: {terminal_frame}"
    );
}

fn relay_frame_payload(frame: &str) -> Option<serde_json::Value> {
    let data = frame.lines().find_map(|line| line.strip_prefix("data: "))?;
    serde_json::from_str(data).ok()
}

/// The committed projection must apply the same `think` block rule as the
/// whole-attempt owner: identical visible text, identical reasoning text, for
/// every provider chunk split. A divergence here is a transport-dependent
/// business result.
#[tokio::test]
async fn relay_first_frame_commit_matches_the_whole_attempt_think_harvest() {
    // Every provider split of the same business text must yield one result.
    let cases = [
        "<think>plan</think>answer",
        "answer",
        "<think>unclosed plan",
        "stray</think>text",
        "<think>a</think><think>b</think>visible",
    ];
    for text in cases {
        for split in 0..=text.len() {
            if !text.is_char_boundary(split) {
                continue;
            }
            let harvest = super::resp_chat_process_03_governed::harvest_v3_think_text(text);
            let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
            let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
                sink,
                relay_test_budget(),
            );
            for part in [&text[..split], &text[split..]] {
                if part.is_empty() {
                    continue;
                }
                projector
                    .on_chat_chunk(&json!({
                        "id": "chatcmpl_think_parity",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "chat-test",
                        "choices": [{"index": 0, "delta": {"content": part},
                                     "finish_reason": null}],
                    }))
                    .expect("content increment");
            }
            if !projector.is_committed() {
                // Nothing was announced, so the runtime never adopts this
                // projection: the whole-attempt path delivers the harvest, which
                // is the behaviour this gate is comparing against.
                continue;
            }
            let terminal = json!({
                "id": "chatcmpl_think_parity",
                "object": "response",
                "status": "completed",
                "output": [],
            });
            let mut sealed = projector.finish(&terminal).expect("seal");
            let mut frames = drain_frames(&mut receiver);
            use futures_util::StreamExt;
            while let Some(frame) = sealed.next().await {
                frames.push(String::from_utf8_lossy(&frame).to_string());
            }
            let mut visible = String::new();
            let mut reasoning = String::new();
            for frame in &frames {
                let Some(payload) = relay_frame_payload(frame) else {
                    continue;
                };
                match payload.get("type").and_then(serde_json::Value::as_str) {
                    Some("response.output_text.delta") => {
                        visible.push_str(
                            payload
                                .get("delta")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or(""),
                        );
                    }
                    Some("response.reasoning_summary_text.delta") => {
                        reasoning.push_str(
                            payload
                                .get("delta")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or(""),
                        );
                    }
                    _ => {}
                }
            }
            assert_eq!(
                visible,
                harvest.visible_text(),
                "visible text must match the whole-attempt harvest for {text:?} split at {split}"
            );
            let expected_reasoning = harvest.reasoning_segments().join("\n");
            assert_eq!(
                reasoning, expected_reasoning,
                "reasoning text must match the whole-attempt harvest for {text:?} split at {split}"
            );
        }
    }
}

/// Chat Process harvests a `think` block out of the visible content on the whole
/// attempt. Once the client holds the first text delta those bytes cannot be
/// rewritten, so the projector applies the same rule while the text arrives:
/// the block becomes reasoning, never output text, and a marker split across
/// provider increments is still one marker.
#[tokio::test]
async fn relay_first_frame_commit_harvests_inline_think_blocks_like_chat_process() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    for content in ["before<thi", "nk>private plan</think", ">after"] {
        projector
            .on_chat_chunk(&json!({
                "id": "chatcmpl_inline_think",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "chat-test",
                "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": null}],
            }))
            .expect("content increment");
    }

    let terminal = json!({
        "id": "chatcmpl_inline_think",
        "object": "response",
        "status": "completed",
        "output": [
            {"type": "message", "role": "assistant",
             "content": [{"type": "output_text", "text": "beforeafter"}]}
        ],
    });
    let mut sealed = projector.finish(&terminal).expect("seal");
    let mut frames = drain_frames(&mut receiver);
    use futures_util::StreamExt;
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }

    assert!(
        !frames
            .iter()
            .any(|frame| frame.contains("response.output_text.delta")
                && frame.contains("private plan")),
        "harvested reasoning must never reach the client as output text: {frames:?}"
    );
    assert!(
        !frames.iter().any(|frame| frame.contains("<think>")
            || frame.contains("</think>")
            || frame.contains("</think")),
        "no delivered frame may carry a think marker: {frames:?}"
    );
    assert!(
        frames.iter().any(
            |frame| frame.contains("response.reasoning_summary_text.delta")
                && frame.contains("private plan")
        ),
        "the harvested block must be delivered as reasoning: {frames:?}"
    );
    let terminal_frame = frames
        .iter()
        .find(|frame| frame.contains("response.completed"))
        .expect("terminal frame");
    assert!(
        terminal_frame.contains("beforeafter"),
        "visible text on both sides of the block must join: {terminal_frame}"
    );
    assert!(
        !terminal_frame.contains("<think>"),
        "terminal message must not carry the marker: {terminal_frame}"
    );
}

/// A provider refusal is legal business content. Once it is streamed it must
/// not disappear from the terminal projection when the attempt seals.
#[tokio::test]
async fn relay_first_frame_commit_preserves_streamed_refusal_in_terminal() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_refusal",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "visible answer"}, "finish_reason": null}],
        }))
        .expect("text chunk");
    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_refusal",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"refusal": "cannot comply"}, "finish_reason": null}],
        }))
        .expect("refusal chunk");

    let terminal = json!({
        "id": "chatcmpl_refusal",
        "object": "response",
        "status": "completed",
        "output": [
            {"type": "message", "role": "assistant",
             "content": [{"type": "refusal", "refusal": "cannot comply"}]}
        ],
    });
    let mut sealed = projector.finish(&terminal).expect("seal");
    let mut frames = drain_frames(&mut receiver);
    use futures_util::StreamExt;
    while let Some(frame) = sealed.next().await {
        frames.push(String::from_utf8_lossy(&frame).to_string());
    }
    let terminal_frame = frames
        .iter()
        .find(|frame| frame.contains("response.completed"))
        .expect("terminal frame");
    assert!(
        terminal_frame.contains("\"type\":\"refusal\"") && terminal_frame.contains("cannot comply"),
        "terminal must keep the streamed refusal item: {terminal_frame}"
    );
}

/// Whitespace is not visible business content: it must not commit the stream,
/// and the first real text must recover the same attempt.
#[tokio::test]
async fn relay_first_frame_commit_ignores_whitespace_only_prefix() {
    let (sink, mut receiver) = crate::nodes::V3CommittedClientFrameSink::channel();
    let mut projector = super::relay_client_frames::V3RelayChatClientStreamProjector::new(
        sink,
        relay_test_budget(),
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_whitespace",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "  \n\t"}, "finish_reason": null}],
        }))
        .expect("whitespace chunk");
    assert!(
        !projector.is_committed(),
        "whitespace alone must never commit the Relay stream"
    );

    projector
        .on_chat_chunk(&json!({
            "id": "chatcmpl_whitespace",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "chat-test",
            "choices": [{"index": 0, "delta": {"content": "real"}, "finish_reason": null}],
        }))
        .expect("real text chunk");
    assert!(
        projector.is_committed(),
        "the first visible text after whitespace must commit the stream"
    );
    let frames = drain_frames(&mut receiver);
    assert!(
        frames.iter().any(|frame| frame.contains("real")),
        "the real text delta must reach the client: {frames:?}"
    );
}
