use super::*;

enum V3AnthropicTextFrame<'a> {
    Ordinary,
    Visible(&'a str),
    InternalOnly,
    Malformed,
}

const DSML_PARAMETER_CLOSE: &str = "<\u{2f}｜DSML｜parameter>";
const DSML_CLOSING_BLOCK: &str =
    concat!("<\u{2f}｜DSML｜parameter>\n<\u{2f}｜DSML｜invoke>\n<\u{2f}｜DSML｜tool_calls>");

fn classify_v3_anthropic_text_frame_at_resp03(text: &str) -> V3AnthropicTextFrame<'_> {
    let Some(after_open) = text.strip_prefix("<thinking>") else {
        return V3AnthropicTextFrame::Ordinary;
    };
    if text.contains("｜DSML｜") {
        if !text.trim_end().ends_with(DSML_CLOSING_BLOCK) {
            return V3AnthropicTextFrame::Malformed;
        }
        // The observed control frame is a whole-item "<thinking> ... closing block".
        // If the provider also emitted a complete closing tag pair with visible prose
        // before the closing block, keep that prose and drop only the frame.
        if let Some((_, remainder)) = after_open.split_once("<\u{2f}thinking>") {
            let visible = remainder
                .split(DSML_PARAMETER_CLOSE)
                .next()
                .unwrap_or("")
                .trim();
            if !visible.is_empty() {
                return V3AnthropicTextFrame::Visible(visible);
            }
        }
        return V3AnthropicTextFrame::InternalOnly;
    }
    let Some((_, visible)) = after_open.split_once("<\u{2f}thinking>") else {
        return V3AnthropicTextFrame::Ordinary;
    };
    if visible.trim().is_empty() {
        V3AnthropicTextFrame::InternalOnly
    } else {
        V3AnthropicTextFrame::Visible(visible)
    }
}

pub(super) fn govern_v3_anthropic_control_text_at_resp03(
    input: &mut V3HubRespInbound02Normalized,
) -> Result<bool, V3HubRelayResponseError> {
    if input.provider_raw().source_provider_protocol != V3HubProviderWireProtocol::Anthropic
        || input.semantic_protocol() != V3HubProviderWireProtocol::Responses
    {
        return Ok(false);
    }
    let mut payload = input.provider_payload().as_ref().clone();
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    let mut changed = false;
    for item in output.iter_mut() {
        let Some(row) = item.as_object_mut() else {
            continue;
        };
        match row.get("type").and_then(Value::as_str) {
            Some("output_text") => {
                let Some(text) = row.get("text").and_then(Value::as_str) else {
                    continue;
                };
                let replacement = match classify_v3_anthropic_text_frame_at_resp03(text) {
                    V3AnthropicTextFrame::Ordinary => continue,
                    V3AnthropicTextFrame::Visible(text) => text.to_string(),
                    V3AnthropicTextFrame::InternalOnly => String::new(),
                    V3AnthropicTextFrame::Malformed => {
                        return Err(V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                            protocol: "anthropic",
                            reason: "incomplete provider control text frame",
                        });
                    }
                };
                row.insert("text".to_string(), Value::String(replacement));
                changed = true;
            }
            Some("message") if row.get("role").and_then(Value::as_str) == Some("assistant") => {
                let Some(parts) = row.get_mut("content").and_then(Value::as_array_mut) else {
                    continue;
                };
                let mut next = Vec::with_capacity(parts.len());
                for mut part in std::mem::take(parts) {
                    if !matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("output_text" | "text")
                    ) {
                        next.push(part);
                        continue;
                    }
                    let Some(text) = part.get("text").and_then(Value::as_str) else {
                        next.push(part);
                        continue;
                    };
                    match classify_v3_anthropic_text_frame_at_resp03(text) {
                        V3AnthropicTextFrame::Ordinary => next.push(part),
                        V3AnthropicTextFrame::Visible(visible) => {
                            part["text"] = Value::String(visible.to_string());
                            next.push(part);
                            changed = true;
                        }
                        V3AnthropicTextFrame::InternalOnly => changed = true,
                        V3AnthropicTextFrame::Malformed => {
                            return Err(
                                V3HubRelayResponseError::ProviderProtocolResponseMalformed {
                                    protocol: "anthropic",
                                    reason: "incomplete provider control text frame",
                                },
                            );
                        }
                    }
                }
                *parts = next;
            }
            _ => {}
        }
    }
    if !changed {
        return Ok(false);
    }
    output.retain(|item| !is_v3_resp03_empty_visible_text_item(item));
    let mut visible_text = String::new();
    for item in output.iter() {
        append_v3_resp03_output_text_segments(&mut visible_text, item);
    }
    let Some(object) = payload.as_object_mut() else {
        return Err(V3HubRelayResponseError::ProviderProtocolResponseMalformed {
            protocol: "anthropic",
            reason: "normalized response output has no parent object",
        });
    };
    if visible_text.is_empty() {
        object.remove("output_text");
    } else {
        object.insert("output_text".to_string(), Value::String(visible_text));
    }
    *input.provider_payload_mut() = Arc::new(payload);
    Ok(true)
}
