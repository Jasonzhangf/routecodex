use super::field_operator_library::*;
use serde_json::{json, Value};

fn opaque_records(canonical: &Value) -> &Vec<Value> {
    canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array()
        .expect("opaque records")
}

#[test]
fn openai_chat_preserves_unknown_fields_and_tool_payloads() {
    let raw = json!({
        "model": "client-model",
        "messages": [{
            "role": "assistant",
            "content": "hello",
            "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "lookup",
                    "arguments": "{\"untouched\":true}"
                }
            }],
            "vendor_extension": {"nested": [1, null, {"x": true}]}
        }],
        "unknown_top_level": {"keep": "exactly"}
    });

    let normalized = normalize_client_request("openai-chat", &raw).expect("openai chat maps");

    assert_eq!(normalized.canonical_request["model"], "client-model");
    assert_eq!(
        normalized.canonical_request["messages"][0]["tool_calls"][0]["function"]["arguments"],
        "{\"untouched\":true}"
    );
    assert_eq!(normalized.inverse_context["tool_declarations"], json!([]));
    assert_eq!(
        normalized.explicit_history_pairing["messages"][0]["call_id"],
        "call-1"
    );
    let records = opaque_records(&normalized.canonical_request);
    assert!(records.iter().any(|record| {
        record["path"] == "request.unknown_top_level" && record["value"]["keep"] == "exactly"
    }));
    assert!(records
        .iter()
        .any(|record| { record["path"] == "request.messages[0].vendor_extension" }));
}

#[test]
fn responses_instructions_and_token_limit_use_chat_destinations() {
    let raw = json!({
        "model": "responses-model",
        "instructions": "follow the client contract",
        "max_output_tokens": 123,
        "include": ["reasoning.encrypted_content"],
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
            {
                "type": "function_call",
                "call_id": "call-2",
                "name": "search",
                "arguments": "{\"opaque\":\"json text\"}"
            }
        ]
    });

    let normalized = normalize_client_request("responses", &raw).expect("responses maps");

    assert_eq!(
        normalized.canonical_request["messages"][0]["role"],
        "system"
    );
    assert_eq!(normalized.canonical_request["max_completion_tokens"], 123);
    assert_eq!(
        normalized.canonical_request["routecodex_chat_extension"]["responses_request"]["include"]
            [0],
        "reasoning.encrypted_content"
    );
    assert_eq!(
        normalized.canonical_request["messages"][2]["tool_calls"][0]["function"]["arguments"],
        "{\"opaque\":\"json text\"}"
    );
    assert!(normalized.inverse_context["field_mappings"]
        .as_array()
        .expect("field mappings")
        .iter()
        .any(|mapping| {
            mapping["source_path"] == "request.include"
                && mapping["destination"]
                    == "chat.routecodex_chat_extension.responses_request.include"
        }));
    let sources = normalized.inverse_context["opaque_record_references"]
        .as_array()
        .expect("source representation references");
    assert!(sources
        .iter()
        .any(|reference| reference["path"] == "request.input[0]"));
    assert!(sources
        .iter()
        .any(|reference| reference["path"] == "request.input[1]"));
    assert!(sources
        .iter()
        .any(|reference| reference["path"] == "request.instructions"));
}

#[test]
fn anthropic_tools_keep_arguments_opaque_and_identity_typed() {
    let raw = json!({
        "model": "claude",
        "max_tokens": 42,
        "messages": [{
            "role": "assistant",
            "content": [
                {"type": "text", "text": "calling"},
                {"type": "tool_use", "id": "toolu-1", "name": "lookup", "input": {"q": 1}}
            ]
        }],
        "tools": [{
            "name": "lookup",
            "description": "Look up",
            "input_schema": {"type": "object"}
        }]
    });

    let normalized = normalize_client_request("anthropic", &raw).expect("anthropic maps");

    assert_eq!(
        normalized.canonical_request["messages"][0]["tool_calls"][0]["function"]["arguments"],
        json!({"q": 1})
    );
    assert_eq!(
        normalized.inverse_context["tool_declarations"][0]["name"],
        "lookup"
    );
    assert_eq!(
        normalized.explicit_history_pairing["messages"][0]["encoding"],
        "json-object"
    );
}

#[test]
fn gemini_top_level_containers_dispatch_by_direction_binding() {
    let raw = json!({
        "model": "gemini-client-model",
        "systemInstruction": {
            "parts": [{"text": "follow the client contract", "vendor": {"keep": 1}}],
            "vendorRoot": {"keep": true}
        },
        "contents": [{
            "role": "user",
            "parts": [{"text": "hello"}]
        }],
        "tools": [{"functionDeclarations": [{"name": "lookup", "description": "Look up"}]}],
        "toolConfig": {
            "functionCallingConfig": {
                "mode": "ANY",
                "allowedFunctionNames": ["lookup", "search"]
            },
            "includeServerSideToolInvocations": true
        },
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 64}
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");

    assert_eq!(
        normalized.canonical_request["messages"][0]["role"],
        "system"
    );
    assert_eq!(
        normalized.canonical_request["messages"][0]["content"],
        "follow the client contract"
    );
    assert_eq!(normalized.canonical_request["messages"][1]["role"], "user");
    assert_eq!(normalized.canonical_request["tool_choice"], "required");
    assert_eq!(normalized.canonical_request["temperature"], json!(0.2));
    assert_eq!(
        normalized.canonical_request["max_completion_tokens"],
        json!(64)
    );
    assert_eq!(
        normalized.inverse_context["tool_declarations"][0]["name"],
        "lookup"
    );
    assert!(normalized.inverse_context["tool_declarations"][0]["record_id"].is_string());
    assert!(normalized.inverse_context["tool_declarations"][0]
        .get("declaration")
        .is_none());
    let records = opaque_records(&normalized.canonical_request);
    assert!(records.iter().any(|record| {
        record["path"] == "request.tools[0].functionDeclarations[0]"
            && record["value"] == raw["tools"][0]["functionDeclarations"][0]
    }));
    assert!(records
        .iter()
        .any(|record| { record["path"] == "request.systemInstruction.parts[0].vendor" }));
    assert!(records
        .iter()
        .any(|record| { record["path"] == "request.systemInstruction.vendorRoot" }));
    assert_eq!(
        normalized.canonical_request["routecodex_chat_extension"]["gemini_request"]["toolConfig"]
            ["functionCallingConfig"]["allowedFunctionNames"],
        json!(["lookup", "search"])
    );
}

#[test]
fn gemini_preserves_unknown_fields_inside_recognized_content_parts() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{
            "role": "user",
            "parts": [
                {
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": "aGVsbG8=",
                        "vendor": {"keep": 1}
                    }
                },
                {
                    "fileData": {
                        "fileUri": "gs://bucket/file",
                        "mimeType": "text/plain",
                        "vendor": {"keep": 2}
                    }
                },
                {
                    "functionCall": {
                        "id": "call_1",
                        "name": "lookup",
                        "args": {"q": 1},
                        "vendor": {"keep": 3}
                    }
                }
            ]
        }]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    let records = opaque_records(&normalized.canonical_request);

    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts[0].inlineData.vendor"
            && record["value"]["keep"] == 1
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts[1].fileData.vendor"
            && record["value"]["keep"] == 2
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts[2].functionCall.vendor"
            && record["value"]["keep"] == 3
    }));
}

#[test]
fn canonical_root_carrier_uses_routecodex_chat_extension_and_preserves_conflicts() {
    let raw = json!({
        "model": "responses-model",
        "input": "hello",
        "extension": {"nested": {"keep": "client business value"}},
        "routecodex_chat_extension": {"nested": {"keep": "conflicting business value"}}
    });

    let normalized = normalize_client_request("gemini", &raw).expect("client carrier conflicts");

    assert_eq!(
        normalized.canonical_request["extension"],
        json!(raw["extension"])
    );
    assert!(normalized.canonical_request["routecodex_chat_extension"]
        ["chat_extension_opaque_record"]
        .is_array());

    let records = opaque_records(&normalized.canonical_request);
    for (path, expected_value) in [
        ("request.extension", raw["extension"].clone()),
        (
            "request.routecodex_chat_extension",
            raw["routecodex_chat_extension"].clone(),
        ),
    ] {
        let record = records
            .iter()
            .find(|record| record["path"] == path)
            .unwrap_or_else(|| panic!("missing opaque record for `{path}`"));
        assert_eq!(record["value"], expected_value);

        let reference = normalized.inverse_context["opaque_record_references"]
            .as_array()
            .expect("opaque record references")
            .iter()
            .find(|reference| reference["path"] == path)
            .unwrap_or_else(|| panic!("missing inverse reference for `{path}`"));
        assert_eq!(reference["record_id"], record["record_id"]);

        let projected = records
            .iter()
            .find(|candidate| candidate["record_id"] == reference["record_id"])
            .expect("inverse reference resolves to opaque record");
        assert_eq!(projected["value"], expected_value);
    }
}

#[test]
fn responses_tool_identities_preserve_namespace_custom_and_complete_strings() {
    let apply_patch_arguments = json!({
        "workdir": "/tmp/apply",
        "free_text": "*** Begin Patch\n*** End Patch\n",
        "nested": {"name": "extension", "input": "*** Begin Patch\n"}
    });
    let raw = json!({
        "model": "responses-model",
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "exec",
                    "parameters": {"command": {"type": "string"}},
                    "extension": {"tool_declaration_nested": {"extension": true}}
                }
            },
            {
                "type": "custom",
                "namespace": "server",
                "name": "apply_patch",
                "input_schema": {"type": "object"}
            },
            {
                "type": "function",
                "namespace": "mcp.search",
                "name": "find",
                "parameters": {"query": {"type": "string"}}
            }
        ],
        "input": [
            {
                "type": "function_call",
                "call_id": "call-function",
                "namespace": "mcp.search",
                "name": "find",
                "arguments": "{\"raw\":\"string\"}"
            },
            {
                "type": "custom_tool_call",
                "call_id": "call-custom",
                "namespace": "server",
                "name": "apply_patch",
                "input": apply_patch_arguments.clone()
            },
            {
                "type": "function_call_output",
                "call_id": "call-function",
                "output": "complete result"
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call-custom",
                "output": {"ok": true}
            }
        ]
    });

    let normalized = normalize_client_request("responses", &raw).expect("responses maps");

    assert_eq!(
        normalized.inverse_context["tool_declarations"][0]["name"],
        "exec"
    );
    assert_eq!(
        normalized.inverse_context["tool_declarations"][0]["kind"],
        "function"
    );
    assert!(normalized.inverse_context["tool_declarations"][0]["namespace"].is_null());
    assert_eq!(
        normalized.inverse_context["tool_declarations"][1]["name"],
        "apply_patch"
    );
    assert_eq!(
        normalized.inverse_context["tool_declarations"][1]["kind"],
        "custom"
    );
    assert_eq!(
        normalized.inverse_context["tool_declarations"][1]["namespace"],
        "server"
    );
    assert_eq!(
        normalized.inverse_context["tool_declarations"][2]["name"],
        "find"
    );
    assert_eq!(
        normalized.inverse_context["tool_declarations"][2]["namespace"],
        "mcp.search"
    );
    let exec_declaration = opaque_records(&normalized.canonical_request)
        .iter()
        .find(|record| {
            record["record_id"] == normalized.inverse_context["tool_declarations"][0]["record_id"]
        })
        .expect("exec declaration opaque record");
    assert_eq!(
        exec_declaration["value"]["function"]["extension"]["tool_declaration_nested"]["extension"],
        json!(true)
    );

    assert_eq!(
        normalized.canonical_request["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp.search__find"
    );
    assert_eq!(
        normalized.canonical_request["messages"][0]["tool_calls"][0]["function"]["arguments"],
        "{\"raw\":\"string\"}"
    );
    assert_eq!(
        normalized.canonical_request["messages"][1]["tool_calls"][0]["custom"]["name"],
        "server.apply_patch"
    );
    assert_eq!(
        normalized.canonical_request["messages"][1]["tool_calls"][0]["custom"]["input"],
        apply_patch_arguments
    );
    assert_eq!(
        normalized.canonical_request["messages"][2]["tool_call_id"],
        "call-function"
    );
    assert_eq!(
        normalized.canonical_request["messages"][2]["content"],
        "complete result"
    );
    assert_eq!(
        normalized.canonical_request["messages"][3]["tool_call_id"],
        "call-custom"
    );
    assert_eq!(
        normalized.canonical_request["messages"][3]["content"],
        json!({"ok": true})
    );

    let pairing = normalized.explicit_history_pairing["messages"]
        .as_array()
        .expect("history pairing");
    assert_eq!(pairing[0]["call_id"], "call-function");
    assert_eq!(pairing[0]["namespace"], "mcp.search");
    assert_eq!(pairing[0]["encoding"], "string");
    assert_eq!(pairing[1]["call_id"], "call-custom");
    assert_eq!(pairing[1]["kind"], "custom");
    assert_eq!(pairing[1]["namespace"], "server");
    assert_eq!(pairing[1]["encoding"], "json-object");
}

#[test]
fn anthropic_message_blocks_preserve_unmapped_siblings() {
    let raw = json!({
        "model": "claude",
        "max_tokens": 42,
        "messages": [{
            "role": "assistant",
            "vendor_message": {"keep": "m"},
            "content": [
                {"type": "text", "text": "calling", "cache_control": {"type": "ephemeral"}},
                {"type": "tool_use", "id": "toolu-1", "name": "lookup", "input": {"q": 1}}
            ]
        }, {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "toolu-1", "content": "ok", "is_error": true}
            ]
        }]
    });

    let normalized = normalize_client_request("anthropic", &raw).expect("anthropic maps");
    let records = opaque_records(&normalized.canonical_request);

    assert!(records.iter().any(|record| {
        record["path"] == "request.messages[0].content[0].cache_control"
            && record["value"]["type"] == "ephemeral"
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.messages[1].content[0].is_error"
            && record["value"] == json!(true)
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.messages[0].vendor_message" && record["value"]["keep"] == "m"
    }));
}

#[test]
fn responses_input_image_is_shaped_into_canonical_chat() {
    let raw = json!({
        "model": "responses-model",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_image",
                "image_url": "https://example.test/image.png",
                "detail": "high",
                "vendor": {"keep": 1}
            }]
        }]
    });

    let normalized = normalize_client_request("responses", &raw).expect("responses maps");

    assert_eq!(
        normalized.canonical_request["messages"][0]["content"][0],
        json!({
            "type": "image_url",
            "image_url": {"url": "https://example.test/image.png", "detail": "high"}
        })
    );
    let records = opaque_records(&normalized.canonical_request);
    assert!(records.iter().any(|record| {
        record["path"] == "request.input[0].content[0].vendor" && record["value"]["keep"] == 1
    }));
}

#[test]
fn gemini_tool_container_siblings_are_preserved() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{"role": "user", "parts": [{"text": "hello"}]}],
        "tools": [{
            "functionDeclarations": [{"name": "lookup"}],
            "vendorConfig": {"keep": true}
        }, {
            "functionDeclarations": [],
            "emptyContainer": {"keep": "e"}
        }]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    let records = opaque_records(&normalized.canonical_request);

    assert!(records.iter().any(|record| {
        record["path"] == "request.tools[0].vendorConfig" && record["value"]["keep"] == json!(true)
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.tools[1].emptyContainer" && record["value"]["keep"] == "e"
    }));
}

#[test]
fn gemini_no_id_tool_result_maps_name_to_the_canonical_message_name() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [
            {"role": "user", "parts": [{"text": "lookup"}]},
            {"role": "model", "parts": [{"functionCall": {"name": "lookup_weather", "args": {"city": "Paris"}}}]},
            {"role": "user", "parts": [{"functionResponse": {"name": "lookup_weather", "response": {"forecast": "sunny"}}}]}
        ]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    let messages = normalized.canonical_request["messages"]
        .as_array()
        .expect("canonical Chat messages");
    let tool_message_index = messages
        .iter()
        .position(|message| message["role"] == "tool")
        .expect("a no-ID functionResponse is still a tool result");
    let tool_message = &messages[tool_message_index];
    assert_eq!(tool_message["name"], "lookup_weather");
    assert!(
        tool_message.get("tool_call_id").is_none(),
        "a no-ID result must not fabricate a tool_call_id: {tool_message}"
    );
    assert_eq!(tool_message["content"], json!({"forecast": "sunny"}));

    let mappings = normalized.inverse_context["field_mappings"]
        .as_array()
        .expect("field mappings");
    let name_mappings = mappings
        .iter()
        .filter(|mapping| {
            mapping["source_path"] == "request.contents[2].parts[0].functionResponse.name"
        })
        .collect::<Vec<_>>();
    assert_eq!(
        name_mappings.len(),
        1,
        "exactly one inverse association for the no-ID result name: {mappings:?}"
    );
    let destination = name_mappings[0]["destination"]
        .as_str()
        .expect("name mapping destination");
    assert_eq!(
        destination,
        format!("chat.messages[{tool_message_index}].name"),
        "the name mapping must resolve to the canonical tool-message name"
    );
    assert_eq!(
        messages[tool_message_index]["name"], "lookup_weather",
        "the declared destination must hold the mapped value"
    );
    assert!(
        messages[tool_message_index]
            .get("routecodex_chat_extension")
            .is_none(),
        "the tool result must not carry a second projection carrier: {}",
        messages[tool_message_index]
    );
}

#[test]
fn responses_tool_call_items_preserve_unmapped_fields() {
    let raw = json!({
        "model": "responses-model",
        "input": [
            {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_1",
                "name": "lookup",
                "arguments": "{\"q\":1}",
                "status": "completed",
                "vendor": {"keep": 1}
            },
            {
                "type": "function_call_output",
                "id": "fco_1",
                "call_id": "call_1",
                "output": "ok",
                "status": "completed"
            }
        ]
    });

    let normalized = normalize_client_request("responses", &raw).expect("responses maps");
    let records = opaque_records(&normalized.canonical_request);

    assert!(records
        .iter()
        .any(|record| record["path"] == "request.input[0].id" && record["value"] == "fc_1"));
    assert!(records.iter().any(|record| {
        record["path"] == "request.input[0].status" && record["value"] == "completed"
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.input[0].vendor" && record["value"]["keep"] == 1
    }));
    assert!(records
        .iter()
        .any(|record| record["path"] == "request.input[1].id" && record["value"] == "fco_1"));
    assert!(records.iter().any(|record| {
        record["path"] == "request.input[1].status" && record["value"] == "completed"
    }));
}

#[test]
fn gemini_non_array_parts_are_preserved_opaque() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{"role": "user", "parts": {"text": "keep", "vendor": true}}]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    let records = opaque_records(&normalized.canonical_request);

    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts"
            && record["value"]["text"] == "keep"
            && record["value"]["vendor"] == json!(true)
    }));
}

#[test]
fn gemini_inline_data_maps_to_canonical_chat_media() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{
            "role": "user",
            "parts": [{
                "inlineData": {
                    "mimeType": "image/png",
                    "data": "aGVsbG8=",
                    "vendor": {"keep": 1}
                }
            }]
        }]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");

    assert_eq!(
        normalized.canonical_request["messages"][0]["content"][0],
        json!({
            "type": "media",
            "media": {
                "inline_data": "aGVsbG8=",
                "mime_type": "image/png",
            },
        })
    );
    let data_mapping = normalized.inverse_context["field_mappings"]
        .as_array()
        .expect("field mappings")
        .iter()
        .find(|mapping| mapping["source_path"] == "request.contents[0].parts[0].inlineData.data")
        .expect("inline data provenance");
    assert_eq!(
        data_mapping["destination"],
        "chat.messages[0].content[0].media.inline_data"
    );
    assert_eq!(
        data_mapping["transform_id"],
        "v3.gemini_inline_data_to_chat_media_inline_data.v1"
    );
    let mime_mapping = normalized.inverse_context["field_mappings"]
        .as_array()
        .expect("field mappings")
        .iter()
        .find(|mapping| {
            mapping["source_path"] == "request.contents[0].parts[0].inlineData.mimeType"
        })
        .expect("inline mime provenance");
    assert_eq!(
        mime_mapping["destination"],
        "chat.messages[0].content[0].media.mime_type"
    );
    assert_eq!(
        mime_mapping["transform_id"],
        "v3.gemini_inline_mime_type_to_chat_media_mime_type.v1"
    );
    let records = opaque_records(&normalized.canonical_request);
    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts[0].inlineData.vendor"
            && record["value"]["keep"] == 1
    }));
}

#[test]
fn gemini_current_turn_inline_image_keeps_exact_canonical_media_value() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [
            {"role": "user", "parts": [{"text": "previous turn"}]},
            {"role": "model", "parts": [{"text": "acknowledged"}]},
            {
                "role": "user",
                "parts": [
                    {"text": "inspect the current image"},
                    {
                        "inlineData": {
                            "mimeType": "image/webp",
                            "data": "UklGRg=="
                        }
                    }
                ]
            }
        ]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    let current_content = normalized.canonical_request["messages"][2]["content"]
        .as_array()
        .expect("current turn content");

    assert_eq!(
        current_content[0],
        json!({"type": "text", "text": "inspect the current image"})
    );
    assert_eq!(
        current_content[1],
        json!({
            "type": "media",
            "media": {
                "inline_data": "UklGRg==",
                "mime_type": "image/webp",
            },
        })
    );
    assert!(current_content[1].get("image_url").is_none());

    let data_mapping = normalized.inverse_context["field_mappings"]
        .as_array()
        .expect("field mappings")
        .iter()
        .find(|mapping| mapping["source_path"] == "request.contents[2].parts[1].inlineData.data")
        .expect("current turn inline data provenance");
    assert_eq!(
        data_mapping["destination"],
        "chat.messages[2].content[1].media.inline_data"
    );
}

#[test]
fn gemini_inline_data_without_mime_preserves_presence() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{
            "role": "user",
            "parts": [{"inlineData": {"data": "aGVsbG8="}}]
        }]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    let media = &normalized.canonical_request["messages"][0]["content"][0]["media"];

    assert_eq!(media["inline_data"], "aGVsbG8=");
    assert!(media.get("mime_type").is_none());
}

#[test]
fn gemini_inline_data_unknown_values_stay_opaque() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{
            "role": "user",
            "parts": [{
                "inlineData": {
                    "data": 123,
                    "mimeType": {"vendor": "keep"},
                    "vendor": {"k": 1}
                }
            }]
        }]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    assert_eq!(
        normalized.canonical_request["messages"][0]["content"][0],
        raw["contents"][0]["parts"][0]
    );
    let records = opaque_records(&normalized.canonical_request);
    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts[0].inlineData"
            && record["value"] == raw["contents"][0]["parts"][0]["inlineData"]
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts[0].inlineData.vendor"
            && record["value"]["k"] == 1
    }));
}

#[test]
fn gemini_inline_data_preserves_part_siblings() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{
            "role": "user",
            "parts": [{
                "inlineData": {"mimeType": "image/jpeg", "data": "/9j/2Q=="},
                "thought": true,
                "vendor": {"keep": {"nested": true}}
            }]
        }]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    assert_eq!(
        normalized.canonical_request["messages"][0]["content"][0],
        json!({
            "type": "media",
            "media": {
                "inline_data": "/9j/2Q==",
                "mime_type": "image/jpeg",
            },
        })
    );
    let records = opaque_records(&normalized.canonical_request);
    for (path, expected_value) in [
        ("request.contents[0].parts[0].thought", json!(true)),
        (
            "request.contents[0].parts[0].vendor",
            json!({"keep": {"nested": true}}),
        ),
    ] {
        let record = records
            .iter()
            .find(|record| record["path"] == path)
            .unwrap_or_else(|| panic!("missing opaque record for `{path}`"));
        assert_eq!(record["value"], expected_value);
    }
}

#[test]
fn gemini_inline_data_with_unrepresentable_values_stays_opaque() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{
            "role": "user",
            "parts": [{
                "inlineData": {
                    "data": 123,
                    "mimeType": {"vendor": "keep"},
                    "vendor": {"k": 1}
                }
            }]
        }]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    let records = opaque_records(&normalized.canonical_request);

    assert!(records.iter().any(|record| {
        record["path"] == "request.contents[0].parts[0].inlineData"
            && record["value"]["data"] == json!(123)
            && record["value"]["mimeType"]["vendor"] == "keep"
    }));
}

#[test]
fn gemini_hosted_tools_do_not_become_fabricated_functions() {
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [{"role": "user", "parts": [{"text": "hello"}]}],
        "tools": [{"googleSearch": {}}, {"codeExecution": {}}]
    });

    let normalized = normalize_client_request("gemini", &raw).expect("gemini maps");
    assert_eq!(normalized.canonical_request["tools"], json!([]));
    for source in ["request.tools[0]", "request.tools[1]"] {
        assert!(normalized.inverse_context["field_mappings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mapping| mapping["source_path"] == source
                && mapping["operator"] == "routecodex.v3.field.tool_declaration_transform@1"
                && mapping["destination"]
                    .as_str()
                    .is_some_and(|destination| destination.starts_with(
                        "chat.routecodex_chat_extension.chat_extension_opaque_record["
                    ) && destination.ends_with(".value"))));
    }

    let records = opaque_records(&normalized.canonical_request);
    assert!(records.iter().any(|record| {
        record["path"] == "request.tools[0]" && record["value"]["googleSearch"].is_object()
    }));
    assert!(records.iter().any(|record| {
        record["path"] == "request.tools[1]" && record["value"]["codeExecution"].is_object()
    }));
}

#[test]
fn field_operator_resolution_requires_exact_identity() {
    use super::field_operator_profiles::{resolve_field_operator_kind, FieldOperatorKind};

    assert_eq!(
        resolve_field_operator_kind("routecodex.v3.field.role_value_map@1"),
        Some(FieldOperatorKind::RoleValueMap)
    );
    assert_eq!(
        resolve_field_operator_kind("routecodex.v3.field.role_value_map@2"),
        None
    );
    assert_eq!(
        resolve_field_operator_kind("other.namespace.role_value_map@1"),
        None
    );
    assert_eq!(
        resolve_field_operator_kind("routecodex.v3.field.not_real@1"),
        None
    );
}

#[test]
fn anthropic_recognized_tool_choice_preserves_unknown_siblings_in_inverse_context() {
    let cases = [
        ("auto", json!("auto")),
        ("any", json!("required")),
        ("none", json!("none")),
        (
            "tool",
            json!({
                "type": "function",
                "function": {"name": "lookup"},
            }),
        ),
    ];

    for (choice_type, expected_choice) in cases {
        let mut tool_choice = json!({
            "type": choice_type,
            "disable_parallel_tool_use": "not-a-bool",
            "vendor": {"keep": choice_type},
        });
        if choice_type == "tool" {
            tool_choice["name"] = json!("lookup");
        }
        let raw = json!({
            "model": "claude",
            "max_tokens": 42,
            "messages": [{"role": "user", "content": "hello"}],
            "tool_choice": tool_choice,
        });

        let normalized = normalize_client_request("anthropic", &raw).expect("anthropic maps");

        assert_eq!(normalized.canonical_request["tool_choice"], expected_choice);
        let records = opaque_records(&normalized.canonical_request);
        for (sibling_path, expected_value) in [
            (
                "request.tool_choice.disable_parallel_tool_use",
                json!("not-a-bool"),
            ),
            (
                "request.tool_choice.vendor",
                raw["tool_choice"]["vendor"].clone(),
            ),
        ] {
            let record = records
                .iter()
                .find(|record| record["path"] == sibling_path)
                .unwrap_or_else(|| panic!("missing opaque record for `{sibling_path}`"));
            assert_eq!(record["value"], expected_value);

            let reference = normalized.inverse_context["opaque_record_references"]
                .as_array()
                .expect("opaque record references")
                .iter()
                .find(|reference| reference["path"] == sibling_path)
                .unwrap_or_else(|| panic!("missing inverse reference for `{sibling_path}`"));
            assert_eq!(reference["record_id"], record["record_id"]);

            let projected = records
                .iter()
                .find(|candidate| candidate["record_id"] == reference["record_id"])
                .expect("inverse reference resolves to opaque record");
            assert_eq!(projected["value"], expected_value);
        }
    }
}

#[test]
fn responses_non_string_tool_identities_are_opaque_and_keep_pairing_recoverable() {
    let raw = json!({
        "model": "responses-model",
        "input": [
            {
                "type": "function_call",
                "call_id": 123,
                "name": {"vendor": "function-name"},
                "arguments": "{\"q\":1}"
            },
            {
                "type": "function_call_output",
                "call_id": 123,
                "output": "ok"
            },
            {
                "type": "custom_tool_call",
                "call_id": {"vendor": "custom-id"},
                "name": 456,
                "input": "raw custom input"
            },
            {
                "type": "custom_tool_call_output",
                "call_id": {"vendor": "custom-id"},
                "output": "custom ok"
            }
        ]
    });

    let normalized = normalize_client_request("responses", &raw).expect("responses maps");
    let records = opaque_records(&normalized.canonical_request);

    for (path, expected_value) in [
        ("request.input[0].call_id", json!(123)),
        ("request.input[0].name", json!({"vendor": "function-name"})),
        ("request.input[1].call_id", json!(123)),
        ("request.input[2].call_id", json!({"vendor": "custom-id"})),
        ("request.input[2].name", json!(456)),
        ("request.input[3].call_id", json!({"vendor": "custom-id"})),
    ] {
        let record = records
            .iter()
            .find(|record| record["path"] == path)
            .unwrap_or_else(|| panic!("missing opaque identity record for `{path}`"));
        assert_eq!(record["value"], expected_value);

        let reference = normalized.inverse_context["opaque_record_references"]
            .as_array()
            .expect("opaque record references")
            .iter()
            .find(|reference| reference["path"] == path)
            .unwrap_or_else(|| panic!("missing inverse reference for `{path}`"));
        assert_eq!(reference["record_id"], record["record_id"]);
    }

    let function_call_id = records
        .iter()
        .find(|record| record["path"] == "request.input[0].call_id")
        .expect("function call identity");
    let function_output_id = records
        .iter()
        .find(|record| record["path"] == "request.input[1].call_id")
        .expect("function output identity");
    assert_eq!(function_call_id["value"], function_output_id["value"]);

    let custom_call_id = records
        .iter()
        .find(|record| record["path"] == "request.input[2].call_id")
        .expect("custom call identity");
    let custom_output_id = records
        .iter()
        .find(|record| record["path"] == "request.input[3].call_id")
        .expect("custom output identity");
    assert_eq!(custom_call_id["value"], custom_output_id["value"]);
}
