use super::V3HubReqInbound02Normalized;
use serde_json::Value;

/// Remove only hosted-search declarations that the selected provider cannot
/// accept. Client function tools, including functions named web_search, stay.
pub(crate) fn project_selected_provider_hosted_search(
    payload: &mut Value,
    model_capabilities: &[String],
) {
    if model_capabilities.iter().any(|capability| capability == "web_search") {
        return;
    }
    fn clean_tools(tools: &mut Vec<Value>, removed_names: &mut Vec<String>) -> Vec<Option<usize>> {
        let mut mapping = Vec::with_capacity(tools.len());
        let mut kept = 0;
        tools.retain_mut(|tool| {
            let Some(row) = tool.as_object_mut() else {
                mapping.push(Some(kept));
                kept += 1;
                return true;
            };
            let hosted = row.get("type").and_then(Value::as_str).is_some_and(|kind| {
                kind == "web_search" || kind.starts_with("web_search_")
            });
            if hosted {
                if let Some(name) = row.get("name").and_then(Value::as_str) {
                    removed_names.push(name.to_owned());
                }
                mapping.push(None);
                return false;
            }
            let had_gemini_search = row.remove("googleSearch").is_some()
                | row.remove("google_search").is_some()
                | row.remove("googleSearchRetrieval").is_some()
                | row.remove("google_search_retrieval").is_some();
            let keep = !had_gemini_search || !row.is_empty();
            mapping.push(keep.then_some(kept));
            if keep { kept += 1; }
            keep
        });
        mapping
    }
    let Some(root) = payload.as_object_mut() else { return };
    let mut removed_names = Vec::new();
    let mapping = root.get_mut("tools").and_then(Value::as_array_mut)
        .map(|tools| clean_tools(tools, &mut removed_names));
    if let Some(input) = root.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
                if let Some(tools) = item.get_mut("tools").and_then(Value::as_array_mut) {
                    let _ = clean_tools(tools, &mut removed_names);
                }
            }
        }
    }
    // Gemini's inverse projection retains canonical indices. Keep those
    // associations aligned so a removed hosted tool cannot reappear and a
    // remaining function cannot inherit a different tool's identity.
    if let Some(mapping) = mapping {
        if let Some(records) = root.get_mut("routecodex_chat_extension")
            .and_then(|extension| extension.get_mut("gemini_native_fields"))
            .and_then(Value::as_array_mut)
        {
            for record in records {
                let Some(tools) = record.get_mut("fields")
                    .and_then(|fields| fields.get_mut("tools"))
                    .and_then(Value::as_array_mut) else { continue };
                tools.retain_mut(|association| {
                    if let Some(old_index) = association.get("canonical_index").and_then(Value::as_u64) {
                        let Some(Some(new_index)) = mapping.get(old_index as usize) else { return false };
                        association["canonical_index"] = Value::from(*new_index as u64);
                    }
                    for key in ["tool_fields", "fields", "native"] {
                        if let Some(row) = association.get_mut(key).and_then(Value::as_object_mut) {
                            for search_key in ["googleSearch", "google_search", "googleSearchRetrieval", "google_search_retrieval"] {
                                row.remove(search_key);
                            }
                        }
                    }
                    true
                });
            }
        }
    }
    root.remove("web_search_options");
    let remove_choice = root.get("tool_choice").is_some_and(|choice| {
        let kind = choice.get("type").and_then(Value::as_str).or_else(|| choice.as_str());
        if kind.is_some_and(|kind| kind == "web_search" || kind.starts_with("web_search_")) {
            return true;
        }
        kind == Some("tool")
            && choice.get("name").and_then(Value::as_str).is_some_and(|name| {
                removed_names.iter().any(|removed| removed == name)
                    && !root.get("tools").and_then(Value::as_array).is_some_and(|tools| {
                        tools.iter().any(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
                    })
            })
    });
    if remove_choice {
        root.remove("tool_choice");
    }
}

/// Apply selected-provider image compatibility to an attempt-local payload.
/// The original request remains unchanged for a later provider attempt.
pub(crate) fn project_selected_provider_images(
    payload: &mut Value,
    model_capabilities: &[String],
    responses_text_blocks: bool,
) {
    if model_capabilities
        .iter()
        .any(|capability| matches!(capability.as_str(), "vision" | "multimodal"))
    {
        return;
    }

    fn visit_content(value: &mut Value, responses_text_blocks: bool) {
        match value {
            Value::Array(items) => {
                for item in items {
                    visit_content(item, responses_text_blocks);
                }
            }
            Value::Object(row) => {
                let kind = row.get("type").and_then(Value::as_str).unwrap_or("");
                let typed_image = matches!(kind, "input_image" | "image_url" | "image");
                let is_tool_result = matches!(kind, "function_call_output" | "tool_result");
                let gemini_image = ["inlineData", "inline_data", "fileData", "file_data"]
                    .iter()
                    .filter_map(|key| row.get(*key))
                    .any(|data| {
                        data.get("mimeType")
                            .or_else(|| data.get("mime_type"))
                            .and_then(Value::as_str)
                            .is_some_and(|mime| mime.starts_with("image/"))
                    });
                if typed_image || gemini_image {
                    if gemini_image {
                        for key in ["inlineData", "inline_data", "fileData", "file_data"] {
                            row.remove(key);
                        }
                    } else {
                        for key in ["image_url", "image", "source", "file_id", "detail"] {
                            row.remove(key);
                        }
                        row.insert(
                            "type".into(),
                            Value::String(if responses_text_blocks { "input_text" } else { "text" }.into()),
                        );
                        // A Gemini-normalized part carries inverse bindings for
                        // its original image. Replace those bindings with the
                        // text placeholder while retaining unrelated siblings.
                        if let Some(records) = row.get_mut("routecodex_chat_extension")
                            .and_then(|extension| extension.get_mut("gemini_native_fields"))
                            .and_then(Value::as_array_mut)
                        {
                            for record in records {
                                if let Some(fields) = record.get_mut("fields").and_then(Value::as_object_mut) {
                                    for key in ["inlineData", "inline_data", "fileData", "file_data"] {
                                        fields.remove(key);
                                    }
                                }
                                if let Some(record) = record.as_object_mut() {
                                    record.insert("bindings".into(), serde_json::json!([{
                                        "source_path": ["text"],
                                        "canonical_path": ["text"],
                                        "encoding": "identity"
                                    }]));
                                }
                            }
                        }
                    }
                    row.insert("text".into(), Value::String("[Image]".into()));
                    return;
                }
                for key in ["content", "parts", "functionResponse", "function_response"] {
                    if let Some(child) = row.get_mut(key) {
                        visit_content(child, responses_text_blocks);
                    }
                }
                if is_tool_result {
                    if let Some(output) = row.get_mut("output") {
                        visit_content(output, responses_text_blocks);
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(row) = payload.as_object_mut() {
        for key in ["input", "messages", "contents", "systemInstruction", "system_instruction"] {
            if let Some(value) = row.get_mut(key) {
                visit_content(value, responses_text_blocks);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqChatProcess04Governed {
    pub(crate) previous: V3HubReqInbound02Normalized,
}

impl V3HubReqChatProcess04Governed {
    /// 治理后的 Chat canonical payload（Req04 治理原地修改 Req02 payload）。
    pub(crate) fn governed_payload(&self) -> &Value {
        self.previous.payload()
    }
}

pub fn build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(
    input: V3HubReqInbound02Normalized,
) -> V3HubReqChatProcess04Governed {
    V3HubReqChatProcess04Governed { previous: input }
}

#[cfg(test)]
mod selected_provider_image_tests {
    use super::{project_selected_provider_hosted_search, project_selected_provider_images};
    use serde_json::json;

    #[test]
    fn image_placeholder_preserves_text_siblings_and_function_arguments() {
        let original = json!({
            "input": [
                {"role":"user", "content":[
                    {"type":"input_text", "text":"keep"},
                    {"type":"input_image", "image_url":"data:image/png;base64,AAAA", "extra":"keep"}
                ]},
                {"type":"function_call", "arguments":"{\"type\":\"input_image\"}"}
            ]
        });
        let mut supported = original.clone();
        project_selected_provider_images(&mut supported, &["vision".into()], true);
        assert_eq!(supported, original);

        let mut unsupported = original.clone();
        project_selected_provider_images(&mut unsupported, &["text".into()], true);
        assert_eq!(unsupported["input"][0]["content"][0], original["input"][0]["content"][0]);
        assert_eq!(unsupported["input"][0]["content"][1], json!({"type":"input_text","text":"[Image]","extra":"keep"}));
        assert_eq!(unsupported["input"][1], original["input"][1]);
    }

    #[test]
    fn gemini_image_is_replaced_without_dropping_other_parts() {
        let mut payload = json!({"contents":[{"role":"user","parts":[
            {"text":"keep"},
            {"inlineData":{"mimeType":"image/png","data":"AAAA"},"extra":"keep"},
            {"inlineData":{"mimeType":"application/pdf","data":"BBBB"}}
        ]}]});
        project_selected_provider_images(&mut payload, &["text".into()], false);
        assert_eq!(payload["contents"][0]["parts"][1], json!({"text":"[Image]","extra":"keep"}));
        assert_eq!(payload["contents"][0]["parts"][2]["inlineData"]["mimeType"], "application/pdf");
    }

    #[test]
    fn hosted_search_removal_keeps_function_tools_and_unrelated_data() {
        let original = json!({
            "input":[{"type":"additional_tools","tools":[
                {"type":"web_search_preview"},
                {"type":"function","name":"lookup","parameters":{"type":"object"}}
            ]}],
            "tools":[
                {"type":"web_search","name":"hosted_search"},
                {"type":"function","function":{"name":"web_search"}},
                {"googleSearch":{},"functionDeclarations":[{"name":"lookup"}]}
            ],
            "tool_choice":{"type":"function","name":"web_search"},
            "web_search_options":{"search_context_size":"low"},
            "unrelated":{"keep":true}
        });
        let mut supported = original.clone();
        project_selected_provider_hosted_search(&mut supported, &["web_search".into()]);
        assert_eq!(supported, original);

        let mut unsupported = original.clone();
        project_selected_provider_hosted_search(&mut unsupported, &["text".into()]);
        assert_eq!(unsupported["tools"].as_array().unwrap().len(), 2);
        assert_eq!(unsupported["tools"][0]["function"]["name"], "web_search");
        assert!(unsupported["tools"][1].get("googleSearch").is_none());
        assert_eq!(unsupported["tools"][1]["functionDeclarations"][0]["name"], "lookup");
        assert_eq!(unsupported["input"][0]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(unsupported["tool_choice"], original["tool_choice"]);
        assert!(unsupported.get("web_search_options").is_none());
        assert_eq!(unsupported["unrelated"], original["unrelated"]);
    }

    #[test]
    fn gemini_native_tool_associations_follow_remaining_canonical_tools() {
        let mut payload = json!({
            "tools":[{"googleSearch":{}},{"type":"function","function":{"name":"lookup"}}],
            "routecodex_chat_extension":{"gemini_native_fields":[{"kind":"request","fields":{"tools":[
                {"canonical_index":0,"tool_fields":{"googleSearch":{}}},
                {"canonical_index":1,"declaration_index":0,"tool_fields":{"googleSearch":{},"other":"keep"}}
            ]}}]}
        });
        project_selected_provider_hosted_search(&mut payload, &["text".into()]);
        assert_eq!(payload["tools"].as_array().unwrap().len(), 1);
        let associations = payload["routecodex_chat_extension"]["gemini_native_fields"][0]["fields"]["tools"].as_array().unwrap();
        assert_eq!(associations.len(), 1);
        assert_eq!(associations[0]["canonical_index"], 0);
        assert_eq!(associations[0]["tool_fields"]["other"], "keep");
        assert!(associations[0]["tool_fields"].get("googleSearch").is_none());
    }
}
