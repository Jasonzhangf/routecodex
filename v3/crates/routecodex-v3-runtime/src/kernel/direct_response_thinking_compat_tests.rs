use super::*;
use crate::shared_direct_thinking_compat::normalize_v3_direct_thinking_json;

#[test]
fn direct_thinking_json_preserves_opaque_parts_and_refreshes_aggregate() {
    let mut item = message_output_item("m", "<thinking>private</thinking>");
    item["content"][0]["annotations"] = json!([{"vendor":"keep"}]);
    let mut payload = json!({"output":[item]});
    let original = payload.clone();
    assert!(!normalize_v3_direct_thinking_json(&mut payload));
    assert_eq!(payload, original);
    let mut payload = json!({"output":[message_output_item("m", "<thinking>private</thinking>")],"output_text":"<thinking>private</thinking>"});
    assert!(normalize_v3_direct_thinking_json(&mut payload));
    assert_eq!(payload["output_text"], "");
}

#[test]
fn direct_thinking_sse_preserves_raw_extensions_and_snapshot() {
    let item = message_output_item("m", "<thinking>private</thinking>");
    let number = "123456789012345678901234567890";
    let created = format!("data: {}\n\n", json!({"type":"response.created","response":{"output":[item.clone()]}}));
    let terminal = format!("data: {{\"type\":\"response.completed\",\"vendor\":{number},\"response\":{{\"vendor\":{number},\"status\":\"completed\",\"output\":[{item}]}}}}\n\n");
    let (frames, _) = rewrite_v3_direct_thinking_attempt(&[created.into_bytes(), terminal.into_bytes()]).unwrap();
    let wire = String::from_utf8(frames.concat()).unwrap();
    assert!(!wire.contains("<thinking>"), "snapshot leaked: {wire}");
    assert_eq!(wire.matches(number).count(), 2, "opaque number changed: {wire}");
}

#[test]
fn direct_thinking_sse_opaque_carrier_remains_associated() {
    let source = tagged_sse(&["<thinking>private</thinking>"], "<thinking>private</thinking>");
    let mut frames = sse_frames(&source);
    let event = json!({"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"<thinking>private</thinking>","vendor":{"keep":true}});
    frames[2] = format!("data: {event}\n\n").into_bytes();
    assert!(rewrite_v3_direct_thinking_attempt(&frames).is_none());
}

#[test]
fn direct_thinking_sse_mixed_body_emits_appended_reasoning() {
    let source = tagged_sse(&["<thinking>private</thinking>answer"], "<thinking>private</thinking>answer");
    let (frames, _) = rewrite_v3_direct_thinking_attempt(&sse_frames(&source)).unwrap();
    let wire = String::from_utf8(frames.concat()).unwrap();
    assert!(wire.contains("response.reasoning_summary_text.delta"), "{wire}");
    assert!(wire.contains("answer"));
}

fn message_output_item(id: &str, text: &str) -> Value {
    json!({
        "id": id,
        "type": "message",
        "status": "completed",
        "role": "assistant",
        "content": [{"type": "output_text", "text": text}]
    })
}

fn normalize_json_response(output: Vec<Value>) -> Value {
    let mut response = json!({
        "id": "resp_d94731e",
        "status": "completed",
        "output": output
    });
    assert!(normalize_v3_direct_thinking_json(&mut response));
    response
}

fn sse_frames(input: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut start = 0usize;
    while let Some(end) = input[start..]
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| start + position + 2)
    {
        frames.push(input[start..end].to_vec());
        start = end;
    }
    frames
}

fn tagged_sse(text_deltas: &[&str], final_text: &str) -> Vec<u8> {
    let mut wire = String::from(
        "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_1\",\"type\":\"message\",\"status\":\"in_progress\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"\"}]}}\n\n",
    );
    wire.push_str("event: response.content_part.added\ndata: {\"type\":\"response.content_part.added\",\"output_index\":0,\"item_id\":\"msg_1\",\"content_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"\"}}\n\n");
    for delta in text_deltas {
        wire.push_str("event: response.output_text.delta\ndata: ");
        wire.push_str(
            &serde_json::to_string(&json!({
                "type":"response.output_text.delta",
                "output_index":0,
                "item_id":"msg_1",
                "content_index":0,
                "delta":delta
            }))
            .unwrap(),
        );
        wire.push_str("\n\n");
    }
    let message = json!({
        "id":"msg_1",
        "type":"message",
        "status":"completed",
        "role":"assistant",
        "content":[{"type":"output_text","text":final_text}]
    });
    for event in [
        json!({"type":"response.output_text.done","output_index":0,"item_id":"msg_1","content_index":0,"text":final_text}),
        json!({"type":"response.content_part.done","output_index":0,"item_id":"msg_1","content_index":0,"part":{"type":"output_text","text":final_text}}),
        json!({"type":"response.output_item.done","output_index":0,"item":message.clone()}),
        json!({"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[message]}}),
    ] {
        wire.push_str("event: ");
        wire.push_str(event["type"].as_str().unwrap());
        wire.push_str("\ndata: ");
        wire.push_str(&serde_json::to_string(&event).unwrap());
        wire.push_str("\n\n");
    }
    wire.into_bytes()
}

#[test]
fn direct_thinking_json_complete_pair_harvests_exact_body_and_keeps_text() {
    let response = normalize_json_response(vec![message_output_item(
        "msg_d94731e_complete",
        "before <thinking> exact body </thinking> after",
    )]);
    assert_eq!(
        response["output"][0]["content"][0]["text"],
        "before  after"
    );
    assert_eq!(response["output"][1]["type"], "reasoning");
    assert_eq!(
        response["output"][1]["summary"][0]["text"],
        " exact body "
    );
}

#[test]
fn direct_thinking_json_leading_unclosed_without_tools_becomes_reasoning() {
    let response = normalize_json_response(vec![message_output_item(
        "msg_d94731e_open",
        "<thinking>leading body",
    )]);
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(
        response["output"][0]["summary"][0]["text"],
        "leading body"
    );
}

#[test]
fn direct_thinking_json_leading_unclosed_with_native_tool_stays_text() {
    let tool = json!({
        "id": "call_d94731e",
        "type": "function_call",
        "status": "completed",
        "call_id": "call_d94731e",
        "name": "exec_command",
        "arguments": {"cmd":["printf","keep"]}
    });
    let response = normalize_json_response(vec![
        message_output_item("msg_d94731e_tool", "<thinking>half body"),
        tool.clone(),
    ]);
    assert_eq!(
        response["output"][0]["content"][0]["text"],
        "half body"
    );
    assert_eq!(response["output"][0]["type"], "message");
    assert_eq!(response["output"][1], tool);
}

#[test]
fn direct_thinking_json_closing_only_removes_marker_and_preserves_surrounding_text() {
    let response = normalize_json_response(vec![message_output_item(
        "msg_d94731e_close",
        "before </thinking> after",
    )]);
    assert_eq!(
        response["output"][0]["content"][0]["text"],
        "before  after"
    );
    assert_eq!(response["output"].as_array().unwrap().len(), 1);
}

#[test]
fn direct_thinking_json_protected_and_malformed_examples_are_unchanged() {
    let text = concat!(
        "Use `<thinking>inline</thinking>`, ",
        "\"<thinking>quoted</thinking>\", ",
        "and <thinkingNow I see: proposal patch line 329 removes current `error =>"
    );
    let mut response = json!({"output": [message_output_item("msg_d94731e_literal", text)]});
    let original = response.clone();
    assert!(!normalize_v3_direct_thinking_json(&mut response));
    assert_eq!(response, original);
}

#[test]
fn direct_thinking_json_preserves_native_reasoning_tool_and_refusal_items() {
    let reasoning = json!({
        "id": "rs_native",
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": "native reasoning"}]
    });
    let tool = json!({
        "id": "call_native",
        "type": "function_call",
        "call_id": "call_native",
        "name": "exec_command",
        "arguments": "{\"cmd\":\"printf keep\"}"
    });
    let refusal = json!({
        "id": "msg_refusal",
        "type": "message",
        "role": "assistant",
        "content": [{"type":"refusal","refusal":"cannot comply"}]
    });
    let response = normalize_json_response(vec![
        reasoning.clone(),
        tool.clone(),
        refusal.clone(),
        message_output_item("msg_aux", "<thinking>aux reasoning"),
    ]);
    assert_eq!(response["output"][0], reasoning);
    assert_eq!(response["output"][1], tool);
    assert_eq!(response["output"][2], refusal);
    assert_eq!(response["output"][3]["content"][0]["text"], "aux reasoning");
}

#[test]
fn direct_sse_thinking_tag_compat_maps_paired_tag_split_across_deltas() {
    let input = tagged_sse(
        &["<thi", "nking>", "inspect", " owner", "</think", "ing>"],
        "<thinking>inspect owner</thinking>",
    );
    let output = rewrite_v3_direct_thinking_tag_sse_bytes(&input).unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(
        text.contains("response.reasoning_summary_text.delta"),
        "{text}"
    );
    assert!(text.contains("\"type\":\"reasoning\""), "{text}");
    assert!(text.contains("inspect owner"), "{text}");
    assert!(!text.contains("<thinking>"), "{text}");
    assert!(!text.contains("</thinking>"), "{text}");
    assert!(!text.contains("response.output_text.delta"), "{text}");
}

#[test]
fn direct_sse_thinking_tag_compat_leading_open_without_tools_becomes_reasoning() {
    let input = tagged_sse(&["<thinking>", "keep visible"], "<thinking>keep visible");
    let output = rewrite_v3_direct_thinking_tag_sse_bytes(&input).unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("keep visible"), "{text}");
    assert!(text.contains("response.reasoning_summary_text.delta"), "{text}");
    assert!(!text.contains("response.output_text.delta"), "{text}");
    assert!(!text.contains("<thinking>"), "{text}");
}

#[test]
fn direct_sse_thinking_tag_compat_strips_orphan_close_tag() {
    let input = tagged_sse(
        &["before ", "</thinking>", " after"],
        "before </thinking> after",
    );
    let output = rewrite_v3_direct_thinking_tag_sse_bytes(&input).unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("response.output_text.delta"), "{text}");
    assert!(text.contains("before "), "{text}");
    assert!(text.contains(" after"), "{text}");
    assert!(
        !text.contains("response.reasoning_summary_text.delta"),
        "{text}"
    );
    assert!(!text.contains("</thinking>"), "{text}");
}

#[test]
fn direct_sse_thinking_tag_compat_keeps_ordinary_response_byte_exact() {
    let input = tagged_sse(&["ordinary"], "ordinary");
    assert_eq!(
        rewrite_v3_direct_thinking_tag_sse_bytes(&input).unwrap(),
        input
    );
}

#[test]
fn direct_thinking_attempt_sse_split_open_without_tools_becomes_reasoning() {
    let input = tagged_sse(&["<thin", "king>leading ", "body"], "<thinking>leading body");
    let frames = sse_frames(&input);
    let (rewritten, terminal_index) =
        rewrite_v3_direct_thinking_attempt(&frames).expect("thinking attempt must change");
    assert!(terminal_index < rewritten.len());
    let text = rewritten
        .iter()
        .map(|frame| String::from_utf8_lossy(frame))
        .collect::<String>();
    assert!(text.contains("response.reasoning_summary_text.delta"), "{text}");
    assert!(text.contains("leading body"), "{text}");
    assert!(!text.contains("<thinking>"), "{text}");
    assert!(!text.contains("response.output_text.delta"), "{text}");
    let terminal = String::from_utf8_lossy(&rewritten[terminal_index]);
    assert!(terminal.contains("\"type\":\"reasoning\""), "{terminal}");
}

#[test]
fn direct_thinking_attempt_sse_tool_preserves_half_marker_body_as_text() {
    let mut input = String::from_utf8(tagged_sse(
        &["<thinking>half ", "body"],
        "<thinking>half body",
    ))
    .unwrap();
    input = input.replace(
        "\"output\":[",
        "\"output\":[{\"id\":\"call_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"exec_command\",\"arguments\":\"{}\"},",
    );
    let frames = sse_frames(input.as_bytes());
    let (rewritten, _) =
        rewrite_v3_direct_thinking_attempt(&frames).expect("thinking markers must be cleaned");
    let text = rewritten
        .iter()
        .map(|frame| String::from_utf8_lossy(frame))
        .collect::<String>();
    assert!(text.contains("half body"), "{text}");
    assert!(!text.contains("<thinking>"), "{text}");
    assert!(!text.contains("response.reasoning_summary_text.delta"), "{text}");
    assert!(text.contains("\"type\":\"function_call\""), "{text}");
}

#[tokio::test]
async fn direct_sse_thinking_tag_consumer_buffers_split_transport_chunks_until_terminal() {
    let input = tagged_sse(
        &["<thinking>", "inspect", "</thinking>"],
        "<thinking>inspect</thinking>",
    );
    let chunks = input
        .chunks(7)
        .map(|chunk| Ok(chunk.to_vec()))
        .collect::<Vec<_>>();
    let mut output = wrap_v3_direct_responses_thinking_tag_consumer_stream(
        V3ProviderAttemptSseStream::new(Box::pin(futures_util::stream::iter(chunks))),
    );

    let first = output.next().await.expect("terminal output").unwrap();
    let text = String::from_utf8(first).unwrap();
    assert!(
        text.contains("response.reasoning_summary_text.delta"),
        "{text}"
    );
    assert!(text.contains("inspect"), "{text}");
    assert!(output.next().await.is_none());
}

#[tokio::test]
async fn direct_sse_thinking_tag_consumer_exports_transport_decode_error() {
    let mut output = wrap_v3_direct_responses_thinking_tag_consumer_stream(
        V3ProviderAttemptSseStream::new(Box::pin(futures_util::stream::iter(vec![Ok(vec![0xff])]))),
    );

    let error = match output.next().await.expect("transport error") {
        Err(Ok(source)) => source,
        Err(Err(fault)) => panic!("unexpected SDK fault: {fault:?}"),
        Ok(_) => panic!("expected transport error"),
    };
    assert_eq!(
        error.source_stage,
        "V3DirectResp14ProviderProjectionPrepared"
    );
    assert!(output.next().await.is_none());
}
