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
    let tool_call_ids: std::collections::HashSet<String> = messages
        .iter()
        .filter(|item| {
            protocol == V3HubProviderWireProtocol::Responses
                && matches!(
                    item["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                )
        })
        .filter_map(|item| item["call_id"].as_str().map(str::to_owned))
        .collect();
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
            // Paired results can carry encoded media parts. An orphan native
            // string remains literal, even when it parses as content parts.
            let paired = message["call_id"]
                .as_str()
                .is_some_and(|id| tool_call_ids.contains(id));
            if let Some(output) = message.get_mut("output") {
                project_tool_output(output, text_type, paired);
            }
        }
        if protocol == V3HubProviderWireProtocol::OpenAiChat && message["role"] == "tool" {
            if let Some(output) = message.get_mut(content) {
                project_tool_output(output, text_type, true);
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
                        project_tool_output(output, text_type, true);
                    }
                } else {
                    project_image_part(part, text_type);
                }
            }
        }
    }
}

fn project_tool_output(output: &mut Value, text_type: &str, project_string_parts: bool) {
    project_tool_output_parts(output, project_string_parts, |part| {
        project_image_part(part, text_type)
    });
}

fn project_tool_output_parts(
    output: &mut Value,
    project_string_parts: bool,
    mut project: impl FnMut(&mut Value) -> bool,
) {
    if let Some(parts) = output.as_array_mut() {
        for part in parts {
            project(part);
        }
    } else if let Some(text) = output.as_str() {
        if is_v3_inline_image_reference(text) {
            *output = json!(IMAGE_PLACEHOLDER);
            return;
        }
        // Unpaired native Responses strings remain literal.
        if !project_string_parts {
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
                project_tool_output_parts(output, true, |part| {
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

#[cfg(test)]
mod provider_req_compat_06_image_placeholder_tests {
    use super::*;

    #[test]
    fn paired_responses_encoded_image_parts_project_without_changing_opaque_parts() {
        let parts = json!([
            {"type":"input_text","text":"image result","vendor_text":{"count":9}},
            {"type":"input_image","image_url":"data:image/png;base64,AAAA","vendor_image":{"count":7}},
            {"type":"input_file","file_id":"file-opaque"},
            {"type":"vendor_part","value":{"count":7}}
        ]);
        let mut payload = json!({"input":[
            {"type":"function_call","call_id":"paired","name":"read_image","arguments":"{}"},
            {"type":"function_call_output","call_id":"paired","output":parts.to_string()},
            {"type":"function_call_output","call_id":"orphan","output":parts.to_string()},
            {"role":"user","content":[{"type":"input_text","text":"later turn"}]}
        ]});
        let original = payload.clone();
        project_default_text_attempt_images(&mut payload, V3HubProviderWireProtocol::Responses);
        let mut expected = parts;
        expected[1] = json!({"type":"input_text","text":"[Image]","vendor_image":{"count":7}});
        assert_eq!(payload["input"][1]["output"], expected.to_string());
        for index in [0, 2, 3] {
            assert_eq!(payload["input"][index], original["input"][index]);
        }
    }

    #[test]
    fn responses_literal_json_strings_stay_literal_and_inline_images_project() {
        for literal in [
            r#"[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]"#,
            r#"[{"type":"input_text","text":"literal"}]"#,
        ] {
            let mut payload = json!({"input":[{"type":"function_call_output","call_id":"orphan","output":literal}]});
            let original = payload.clone();
            project_default_text_attempt_images(&mut payload, V3HubProviderWireProtocol::Responses);
            assert_eq!(payload, original);
        }
        let mut payload = json!({"input":[
            {"type":"function_call_output","call_id":"image","output":"data:image/png;base64,AAAA"},
            {"type":"function_call_output","call_id":"array","output":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"},{"type":"input_file","file_id":"file-123"}]}
        ]});
        project_default_text_attempt_images(&mut payload, V3HubProviderWireProtocol::Responses);
        assert_eq!(payload["input"][0]["output"], "[Image]");
        assert_eq!(
            payload["input"][1]["output"],
            json!([
                {"type":"input_text","text":"[Image]"},
                {"type":"input_file","file_id":"file-123"}
            ])
        );
    }
}
