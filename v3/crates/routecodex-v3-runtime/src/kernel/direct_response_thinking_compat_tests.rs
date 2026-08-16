use super::*;

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
fn direct_sse_thinking_tag_compat_strips_unpaired_open_tag_only() {
    let input = tagged_sse(&["<thinking>", "keep visible"], "<thinking>keep visible");
    let output = rewrite_v3_direct_thinking_tag_sse_bytes(&input).unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("response.output_text.delta"), "{text}");
    assert!(text.contains("keep visible"), "{text}");
    assert!(
        !text.contains("response.reasoning_summary_text.delta"),
        "{text}"
    );
    assert!(!text.contains("<thinking>"), "{text}");
}

#[test]
fn direct_sse_thinking_tag_compat_keeps_ordinary_response_byte_exact() {
    let input = tagged_sse(&["ordinary"], "ordinary");
    assert_eq!(
        rewrite_v3_direct_thinking_tag_sse_bytes(&input).unwrap(),
        input
    );
}
