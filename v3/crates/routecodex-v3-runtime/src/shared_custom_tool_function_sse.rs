use provider_compat_core::CustomToolFunctionSseState;

pub(crate) fn apply_custom_tool_function_sse_chunk_buffered(
    buffer: &mut Vec<u8>,
    state: &mut CustomToolFunctionSseState,
    chunk: &[u8],
) -> Vec<u8> {
    buffer.extend_from_slice(chunk);
    let mut output = Vec::new();
    while let Some(frame_end) = find_sse_frame_end(buffer) {
        let frame: Vec<u8> = buffer.drain(..frame_end).collect();
        output.extend(apply_custom_tool_function_sse_chunk(&frame, state));
    }
    output
}

/// SSE frames end at a blank line. Providers may terminate lines with LF, CRLF,
/// or CR, so the custom-tool projection must recognize all three before it
/// rewrites a frame. An unterminated CRLF is left buffered until more bytes
/// arrive.
fn find_sse_frame_end(buffer: &[u8]) -> Option<usize> {
    let mut line_start = 0;
    let mut index = 0;
    while index < buffer.len() {
        let ending_len = match buffer[index] {
            b'\n' => 1,
            b'\r' if buffer.get(index + 1) == Some(&b'\n') => 2,
            b'\r' if buffer.get(index + 1).is_none() => return None,
            b'\r' => 1,
            _ => {
                index += 1;
                continue;
            }
        };
        if index == line_start {
            return Some(index + ending_len);
        }
        index += ending_len;
        line_start = index;
    }
    None
}

/// Flush a trailing custom-tool frame the SSE decoder already accepted. When
/// the decoder still holds bytes, the unterminated frame stays with the decoder
/// so it surfaces as the typed provider SSE error instead of a partial client
/// frame.
pub(crate) fn flush_custom_tool_function_sse_buffer(
    buffer: &mut Vec<u8>,
    state: &mut CustomToolFunctionSseState,
    decoder_has_remaining: bool,
) -> Option<Vec<u8>> {
    if buffer.is_empty() || decoder_has_remaining {
        return None;
    }
    let frame = std::mem::take(buffer);
    Some(apply_custom_tool_function_sse_chunk(&frame, state))
}

fn apply_custom_tool_function_sse_chunk(
    frame: &[u8],
    state: &mut CustomToolFunctionSseState,
) -> Vec<u8> {
    let text = String::from_utf8_lossy(frame);
    // Normalize CRLF/CR so the rewrite handles every SSE line terminator.
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<String> = normalized
        .split_inclusive('\n')
        .map(ToOwned::to_owned)
        .collect();
    // SSE allows one JSON event to be split across several `data:` lines. The
    // spec joins them with a newline before the payload is interpreted.
    let mut data_payload = String::new();
    for line in &lines {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        if !data_payload.is_empty() {
            data_payload.push('\n');
        }
        data_payload.push_str(data.trim_end_matches('\n'));
    }
    let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(&data_payload) else {
        return normalized.into_bytes();
    };
    provider_compat_core::apply_custom_tool_function_sse_event_compat(&mut payload, state);
    let serialized = serde_json::to_string(&payload).unwrap_or_else(|_| data_payload.clone());
    let mut output = String::new();
    let mut wrote_data = false;
    for line in &lines {
        if line.strip_prefix("data:").is_some() {
            if !wrote_data {
                output.push_str("data:");
                output.push_str(&serialized);
                output.push('\n');
                wrote_data = true;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            if let Some(payload_type) = payload.get("type").and_then(serde_json::Value::as_str) {
                let newline = rest.ends_with('\n');
                output.push_str("event: ");
                output.push_str(payload_type);
                if newline {
                    output.push('\n');
                }
                continue;
            }
        }
        output.push_str(line);
    }
    output.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CUSTOM_TOOL_WIRE_NAME: &str = "routecodex_custom__6170706c795f7061746368";
    const CUSTOM_TOOL_NAME: &str = "apply_patch";

    /// The SSE owner consumes the request-scoped binding the same way the
    /// runtime does. Positive projection tests must start from that binding,
    /// otherwise an empty state legitimately leaves ordinary function frames
    /// untouched.
    fn custom_tool_state() -> CustomToolFunctionSseState {
        let binding =
            provider_compat_core::compile_custom_tool_function_binding(&serde_json::json!({
                "tools": [{"type": "custom", "name": CUSTOM_TOOL_NAME}]
            }));
        CustomToolFunctionSseState::new(binding)
    }

    #[test]
    fn custom_tool_function_sse_drops_partial_function_arguments_frame() {
        let mut buffer = Vec::new();
        let mut state = custom_tool_state();
        let added = format!(
            "event: response.output_item.added\ndata: {{\"type\":\"response.output_item.added\",\"item\":{{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"{CUSTOM_TOOL_WIRE_NAME}\",\"arguments\":\"\"}}}}\n\n"
        );
        assert!(!apply_custom_tool_function_sse_chunk_buffered(
            &mut buffer,
            &mut state,
            added.as_bytes(),
        )
        .is_empty());

        let partial = b"event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"input\\\":\\\"*** Begin \"}\n\n";
        let projected =
            apply_custom_tool_function_sse_chunk_buffered(&mut buffer, &mut state, partial);
        let text = String::from_utf8(projected).expect("projected partial delta");
        assert!(text.contains("event: response.custom_tool_call_input.delta"));
        assert!(text.contains("\"delta\":\"\""));
        assert!(!text.contains("response.function_call_arguments.delta"));
    }

    #[test]
    fn custom_tool_function_sse_buffer_accepts_crlf_and_cr_frames() {
        // A trailing CR-only terminator is held until the next byte, matching
        // the shared SSE decoder, so each frame is followed by one sentinel
        // byte that must remain buffered.
        for frame in [
            format!("event: response.output_item.added\r\ndata: {{\"type\":\"response.output_item.added\",\"item\":{{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"{CUSTOM_TOOL_WIRE_NAME}\",\"arguments\":\"\"}}}}\r\n\r\nx"),
            format!("event: response.output_item.added\rdata: {{\"type\":\"response.output_item.added\",\"item\":{{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"{CUSTOM_TOOL_WIRE_NAME}\",\"arguments\":\"\"}}}}\r\rx"),
        ] {
            let mut buffer = Vec::new();
            let mut state = custom_tool_state();
            let projected = apply_custom_tool_function_sse_chunk_buffered(
                &mut buffer,
                &mut state,
                frame.as_bytes(),
            );
            let text = String::from_utf8(projected).expect("projected frame");
            assert!(text.contains("event: response.output_item.added"), "{text}");
            assert!(text.contains("\"type\":\"custom_tool_call\""), "{text}");
            assert!(!text.contains(CUSTOM_TOOL_WIRE_NAME), "{text}");
            assert_eq!(
                buffer,
                b"x",
                "only the trailing sentinel byte may remain buffered"
            );
        }
    }

    #[test]
    fn custom_tool_function_sse_flush_reprojects_complete_trailing_frame_only() {
        let mut buffer = format!(
            "event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"output\":[{{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"{CUSTOM_TOOL_WIRE_NAME}\",\"arguments\":\"{{\\\"input\\\":\\\"done\\\"}}\"}}]}}}}"
        )
        .into_bytes();
        let mut state = custom_tool_state();
        let projected = flush_custom_tool_function_sse_buffer(&mut buffer, &mut state, false)
            .expect("complete trailing frame must flush");
        let text = String::from_utf8(projected).expect("flushed frame");
        assert!(text.contains("\"type\":\"custom_tool_call\""), "{text}");
        assert!(!text.contains(CUSTOM_TOOL_WIRE_NAME), "{text}");
        assert!(buffer.is_empty());

        let mut buffer = b"data: {\"type\":\"response.completed\"".to_vec();
        let mut state = CustomToolFunctionSseState::default();
        assert!(
            flush_custom_tool_function_sse_buffer(&mut buffer, &mut state, true).is_none(),
            "unterminated decoder frame must stay with the decoder"
        );
        assert_eq!(buffer, b"data: {\"type\":\"response.completed\"");
    }

    #[test]
    fn custom_tool_function_sse_aggregates_multiline_data_before_mapping() {
        let mut buffer = Vec::new();
        let mut state = custom_tool_state();
        let frame = format!(
            "event: response.output_item.done\n\
             data: {{\"type\":\"response.output_item.done\",\n\
             data: \"output_index\":3,\"item\":{{\"id\":\"fc_multi\",\"type\":\"function_call\",\n\
             data: \"call_id\":\"call_multi\",\"name\":\"{CUSTOM_TOOL_WIRE_NAME}\",\"arguments\":\"{{\\\"input\\\":\\\"multi\\\"}}\"}}}}\n\n"
        );
        let projected = apply_custom_tool_function_sse_chunk_buffered(
            &mut buffer,
            &mut state,
            frame.as_bytes(),
        );
        let text = String::from_utf8(projected).expect("projected multiline frame");
        assert_eq!(
            text.lines()
                .filter(|line| line.starts_with("data:"))
                .count(),
            1,
            "{text}"
        );
        let payload: serde_json::Value = serde_json::from_str(
            text.lines()
                .find_map(|line| line.strip_prefix("data:"))
                .expect("projected data line"),
        )
        .expect("projected payload must stay JSON");
        assert_eq!(payload["type"], "response.output_item.done");
        assert_eq!(payload["output_index"], 3);
        assert_eq!(payload["item"]["type"], "custom_tool_call");
        assert_eq!(payload["item"]["id"], "fc_multi");
        assert_eq!(payload["item"]["call_id"], "call_multi");
        assert_eq!(payload["item"]["name"], "apply_patch");
        assert_eq!(payload["item"]["input"], "multi");
        assert!(payload["item"].get("arguments").is_none());
    }

    #[test]
    fn custom_tool_function_sse_preserves_malformed_multiline_data() {
        let mut buffer = Vec::new();
        let mut state = CustomToolFunctionSseState::default();
        let frame = b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\"\ndata: malformed\n\n";
        let projected =
            apply_custom_tool_function_sse_chunk_buffered(&mut buffer, &mut state, frame);
        assert_eq!(
            String::from_utf8(projected).expect("malformed frame stays utf8"),
            "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\"\ndata: malformed\n\n"
        );
    }

    #[test]
    fn custom_tool_function_sse_leaves_unbound_function_frames_untouched() {
        let mut buffer = Vec::new();
        let mut state = custom_tool_state();
        let frame = b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"exec_command\",\"arguments\":\"\"}}\n\n";
        let projected =
            apply_custom_tool_function_sse_chunk_buffered(&mut buffer, &mut state, frame);
        let text = String::from_utf8(projected).expect("unbound frame stays utf8");
        assert!(
            text.contains("\"type\":\"function_call\""),
            "an ordinary function that is not in the binding must stay a function_call: {text}"
        );
        assert!(
            text.contains("\"name\":\"exec_command\""),
            "an ordinary function name must not be rewritten: {text}"
        );
    }
}
