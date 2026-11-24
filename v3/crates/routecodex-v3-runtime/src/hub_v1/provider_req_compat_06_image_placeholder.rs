use routecodex_v3_route_classifier::is_v3_inline_image_reference;
use serde_json::{json, Value};

use super::V3HubProviderWireProtocol;

const IMAGE_PLACEHOLDER: &str = "[Image]";

/// Only visit protocol content fields in the selected attempt's wire body.
pub(super) fn project_default_text_attempt_images(
    payload: &mut Value,
    protocol: V3HubProviderWireProtocol,
) {
    let (messages, content) = match protocol {
        V3HubProviderWireProtocol::Responses => ("input", "content"),
        V3HubProviderWireProtocol::OpenAiChat | V3HubProviderWireProtocol::Anthropic => {
            ("messages", "content")
        }
        V3HubProviderWireProtocol::Gemini => ("contents", "parts"),
    };
    let Some(messages) = payload.get_mut(messages).and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages {
        let text_type = match protocol {
            V3HubProviderWireProtocol::Responses if message["role"] == "assistant" => "output_text",
            V3HubProviderWireProtocol::Responses => "input_text",
            _ => "text",
        };
        if matches!(
            message["type"].as_str(),
            Some("function_call_output" | "custom_tool_call_output")
        ) && protocol == V3HubProviderWireProtocol::Responses
        {
            if let Some(output) = message.get_mut("output") {
                project_tool_output(output, text_type);
            }
        }
        if protocol == V3HubProviderWireProtocol::OpenAiChat && message["role"] == "tool" {
            if let Some(output) = message.get_mut(content) {
                project_tool_output(output, text_type);
            }
            continue;
        }
        if let Some(parts) = message.get_mut(content).and_then(Value::as_array_mut) {
            if protocol == V3HubProviderWireProtocol::Gemini {
                project_gemini_parts(parts);
                continue;
            }
            for part in parts {
                if protocol == V3HubProviderWireProtocol::Anthropic && part["type"] == "tool_result"
                {
                    if let Some(output) = part.get_mut("content") {
                        project_tool_output(output, text_type);
                    }
                } else {
                    project_image_part(part, text_type);
                }
            }
        }
    }
}

fn project_tool_output(output: &mut Value, text_type: &str) {
    project_tool_output_parts(output, |part| project_image_part(part, text_type));
}

fn project_tool_output_parts(output: &mut Value, mut project: impl FnMut(&mut Value) -> bool) {
    if let Some(parts) = output.as_array_mut() {
        for part in parts {
            project(part);
        }
    } else if let Some(text) = output.as_str() {
        if is_v3_inline_image_reference(text) {
            *output = json!(IMAGE_PLACEHOLDER);
            return;
        }
        // Responses may carry the tool's content-part array as JSON text.
        if let Ok(mut parts) = serde_json::from_str::<Vec<Value>>(text) {
            let mut changed = false;
            for part in &mut parts {
                changed |= project(part);
            }
            if changed {
                *output = Value::String(Value::Array(parts).to_string());
            }
        }
    }
}

pub(crate) fn project_image_part(part: &mut Value, text_type: &str) -> bool {
    let Some(part) = part.as_object_mut() else {
        return false;
    };
    let is_image = match part.get("type").and_then(Value::as_str) {
        Some("input_image" | "output_image" | "image_url" | "image") => true,
        None => {
            part.contains_key("image_url")
                || part
                    .get("data")
                    .and_then(Value::as_str)
                    .is_some_and(|data| data.starts_with("data:image/"))
        }
        _ => false,
    };
    if !is_image {
        return false;
    }
    for field in [
        "image_url",
        "file_url",
        "file_id",
        "source",
        "data",
        "media_type",
        "detail",
        "url",
    ] {
        part.remove(field);
    }
    part.insert("type".into(), json!(text_type));
    part.insert("text".into(), json!(IMAGE_PLACEHOLDER));
    true
}

fn project_gemini_parts(parts: &mut Vec<Value>) {
    for mut part in std::mem::take(parts) {
        let mut placeholders = Vec::new();
        if let Some(tool) = part.get_mut("functionResponse") {
            if let Some(output) = tool
                .get_mut("response")
                .and_then(|response| response.get_mut("output"))
            {
                project_tool_output_parts(output, |part| {
                    project_gemini_image_part(part) || project_image_part(part, "text")
                });
            }
            if let Some(attachments) = tool.get_mut("parts").and_then(Value::as_array_mut) {
                attachments.retain_mut(|attachment| {
                    if project_gemini_image_part(attachment) {
                        placeholders.push(std::mem::take(attachment));
                        false
                    } else {
                        true
                    }
                });
            }
        } else {
            project_gemini_image_part(&mut part);
        }
        // FunctionResponsePart is an attachment. Put text placeholders next to
        // the function response as ordinary Gemini Parts.
        parts.push(part);
        parts.extend(placeholders);
    }
}

fn project_gemini_image_part(part: &mut Value) -> bool {
    for field in ["inlineData", "inline_data", "fileData", "file_data"] {
        if part[field]
            .get("mimeType")
            .or_else(|| part[field].get("mime_type"))
            .and_then(Value::as_str)
            .is_some_and(|mime| mime.starts_with("image/"))
        {
            if let Some(part) = part.as_object_mut() {
                part.remove(field);
                part.insert("text".into(), json!(IMAGE_PLACEHOLDER));
                return true;
            }
            break;
        }
    }
    false
}
