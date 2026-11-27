use super::*;
use routecodex_v3_config::V3WebSearchExecutionMode;

#[test]
fn responses_openai_chat_field_parity_responses_wire_projects_fc_item_ids() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_6b0251fee24f41b2b045b04e",
                    "type": "function",
                    "function": {"name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"}
                }]
            },
            {"role": "tool", "tool_call_id": "call_6b0251fee24f41b2b045b04e", "content": "ok"}
        ]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    assert_eq!(input[0]["call_id"], "call_6b0251fee24f41b2b045b04e");
    let item_id = input[0]["id"].as_str().expect("function_call id");
    assert!(item_id.starts_with("fc_6b0251fee24f41b2b045b04e_"));
    assert!(item_id.len() <= 64);
    assert_eq!(input[1]["call_id"], input[0]["call_id"]);
    assert_eq!(input[1]["id"], input[0]["id"]);
}

#[test]
fn responses_wire_wraps_apply_patch_custom_tool_without_retired_schema() {
    let payload = json!({"model": "gpt-test", "messages": [{"role": "user", "content": "patch"}], "tools": [{"type": "custom", "name": "apply_patch", "description": "Apply a patch", "format": {"type":"grammar","syntax":"lark","definition":"start: patch"}}]});

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire must wrap custom apply_patch as a function schema");
    let tool = &request["tools"][0];
    assert_eq!(tool["type"], "function");
    assert_eq!(tool["function"]["name"], "apply_patch");
    assert_eq!(tool["function"]["parameters"]["required"], json!(["input"]));
    assert!(tool["function"]["parameters"]["properties"]
        .get("reason")
        .is_none());
    assert!(tool["function"]["parameters"]["properties"]
        .get("goal_alignment_confidence")
        .is_none());
    assert!(tool["function"]["parameters"]["properties"]
        .get("model_id")
        .is_none());
}

#[test]
fn responses_wire_normalizes_system_text_parts_to_input_text() {
    let payload = json!({"model": "gpt-test", "messages": [{"role": "system", "content": [{"type": "text", "text": "system guidance"}]}, {"role": "assistant", "content": [{"type": "text", "text": "assistant output", "opaque": {"keep": true}}]}]});

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire must normalize system content parts");
    assert_eq!(request["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(
        request["input"][1]["content"][0],
        json!({"type":"output_text","text":"assistant output","opaque":{"keep":true}})
    );
}

#[test]
fn responses_openai_chat_field_parity_assistant_text_representations() {
    for content in [
        json!(" preserved assistant text \n"),
        json!([{"type":"text","text":" preserved assistant text \n"}]),
        json!([{"type":"output_text","text":" preserved assistant text \n"}]),
    ] {
        let payload =
            json!({"model":"gpt-test","messages":[{"role":"assistant","content":content}]});
        let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
            .expect("assistant text must be representable in Responses");
        assert_eq!(
            request["input"][0]["content"],
            json!([{"type":"output_text","text":" preserved assistant text \n"}])
        );
    }
}

#[test]
fn responses_openai_chat_field_parity_responses_wire_generates_collision_resistant_fc_ids() {
    let repeated_prefix = "call_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv";
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "assistant", "content": null, "tool_calls": [{"id": format!("{repeated_prefix}_left"), "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}, {"id": format!("{repeated_prefix}_right"), "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}]}]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    assert_ne!(input[0]["id"], input[1]["id"]);
    for item in input {
        let id = item["id"].as_str().expect("Responses item id");
        assert!(id.starts_with("fc_"), "id must keep fc_ prefix: {id}");
        // 超长 id 原样保留（不按长度截断），仅带 hash 后缀防碰撞。
        assert!(
            id.contains(&format!("{}_", &repeated_prefix[5..])),
            "overlong id must be preserved verbatim: {id}"
        );
    }
}

#[test]
fn responses_openai_chat_field_parity_responses_wire_hashes_sanitized_collisions() {
    let tool_calls = [
        "call_same/value",
        "call_same:value",
        "call_same",
        "fc_same",
        "functions.same",
    ]
    .into_iter()
    .map(|id| {
        json!({"id": id, "type": "function", "function": {"name": "exec_command", "arguments": "{}"}})
    })
    .collect::<Vec<_>>();
    let payload = json!({
        "model": "gpt-test",
        "messages": [{
            "role": "assistant",
            "content": null,
            "tool_calls": tool_calls
        }]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    let ids = input
        .iter()
        .map(|item| item["id"].as_str().expect("Responses item id"))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        ids.len(),
        input.len(),
        "Responses fc_* item ids collided: {input:?}"
    );
    for item in input {
        assert!(item["id"].as_str().unwrap().starts_with("fc_same"));
    }
}

#[test]
fn responses_wire_reuses_chat_extension_responses_item_id() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_original",
                    "type": "function",
                    "function": {"name":"lookup", "arguments":"{\"q\":\"x\"}"},
                    "routecodex_chat_extension": {"responses_item_id":"fc_original"}
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_original",
                "content": "ok",
                "routecodex_chat_extension": {"responses_item_id":"fc_original"}
            }
        ]
    });

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must preserve adjacent codec item id");
    let input = request["input"].as_array().expect("Responses input array");

    assert_eq!(input[0]["type"], "function_call");
    assert_eq!(input[0]["id"], "fc_original");
    assert_eq!(input[0]["call_id"], "call_original");
    assert_eq!(input[1]["type"], "function_call_output");
    assert_eq!(input[1]["id"], "fc_original");
    assert_eq!(input[1]["call_id"], "call_original");
}

#[test]
fn responses_wire_projects_non_fc_function_item_ids_to_matching_fc_ids() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_original",
                    "type": "function",
                    "function": {"name":"lookup", "arguments":"{\"q\":\"x\"}"},
                    "routecodex_chat_extension": {"responses_item_id":"item_e4dbebeb61535f2bdf4c15c7"}
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_original",
                "content": "ok",
                "routecodex_chat_extension": {"responses_item_id":"item_e4dbebeb61535f2bdf4c15c7"}
            }
        ]
    });

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projects function item ids at the adjacent codec");
    let input = request["input"].as_array().expect("Responses input array");

    assert!(input[0]["id"].as_str().unwrap().starts_with("fc_"));
    assert_eq!(input[1]["id"], input[0]["id"]);
    assert_eq!(input[0]["call_id"], "call_original");
    assert_eq!(input[1]["call_id"], "call_original");
}

#[test]
fn responses_wire_preserves_custom_tool_item_ids() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_custom",
                    "type": "function",
                    "function": {"name":"custom.render", "arguments":"{\"input\":\"raw script\"}"},
                    "routecodex_chat_extension": {
                        "responses_tool_call_type":"custom_tool_call",
                        "responses_item_id":"ctc_provider_owned"
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_custom",
                "content": "rendered",
                "routecodex_chat_extension": {
                    "responses_tool_output_type":"custom_tool_call_output",
                    "responses_item_id":"ctc_provider_owned"
                }
            }
        ]
    });

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire must preserve opaque custom-tool item identity");
    let input = request["input"].as_array().expect("Responses input array");

    assert_eq!(input[0]["type"], "custom_tool_call");
    assert_eq!(input[0]["id"], "ctc_provider_owned");
    assert_eq!(input[0]["call_id"], "call_custom");
    assert_eq!(input[1]["type"], "custom_tool_call_output");
    assert_eq!(input[1]["id"], "ctc_provider_owned");
    assert_eq!(input[1]["call_id"], "call_custom");
}

#[test]
fn openai_chat_wire_passes_through_same_protocol_thinking_field() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "thinking": {"type": "enabled", "budget_tokens": 1024}
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("same-protocol OpenAI Chat wire must pass through client thinking field");
    assert_eq!(request["thinking"]["type"], "enabled");
    assert_eq!(request["thinking"]["budget_tokens"], 1024);
}

#[test]
fn responses_openai_chat_field_parity_include_is_preserved_opaquely_in_chat_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "include": ["reasoning.encrypted_content"]
    });

    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("Responses include remains opaque business data in Chat wire");

    assert_eq!(wire["include"], payload["include"]);
}

#[test]
fn outbound_projection_preserves_business_fields_with_control_names() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": [{"type":"text", "text":"hello", "_debug": true}]}],
        "metadata_center": {"route": "internal"}
    });

    let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("business spelling cannot establish control provenance");
    assert_eq!(wire["metadata_center"], payload["metadata_center"]);
    assert_eq!(wire["messages"], payload["messages"]);
}

#[test]
fn outbound_projection_preserves_tool_search_output_underscore_schema_names() {
    let content = "[{\"type\":\"namespace\",\"name\":\"mcp\",\"tools\":[{\"type\":\"function\",\"name\":\"_patch_page\",\"parameters\":{\"$defs\":{\"_ReplaceBlock\":{\"type\":\"object\"}},\"properties\":{\"replace_block\":{\"$ref\":\"#/$defs/_ReplaceBlock\"}}}}]}]";
    let payload = json!({"model":"gpt-test","messages":[{"role":"tool","tool_call_id":"call_search","content":content}]});
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("tool-search JSON Schema underscore names are business data");
    let outbound_content = request["messages"][0]["content"]
        .as_str()
        .expect("tool output remains stringified");
    assert!(
        outbound_content.contains("_ReplaceBlock"),
        "{outbound_content}"
    );
}

#[test]
fn openai_chat_wire_consumes_registered_codex_client_metadata_as_local_context() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "client_metadata": {
            "session_id":"client-owned",
            "x-codex-turn-metadata":"x".repeat(600)
        }
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("registered Codex client metadata is local request context");

    assert!(
        request.get("client_metadata").is_none(),
        "OpenAI Chat wire must not forward client_metadata: {request}"
    );
    assert!(request.get("metadata").is_none(), "{request}");
}

#[test]
fn openai_chat_wire_omits_unknown_client_metadata_with_records() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "client_metadata": {"user_id":"client-user", "unknown":{"nested":true},
            "future.key":{"values":[1,"two"]}, "bracket]quote\"": [true], "": 7}
    });

    let context = V3ProjectionDropContext::new(
        "metadata-control",
        "12345",
        None,
        std::sync::Arc::new(payload.clone()),
    );
    let (wire, mut records) =
        build_v3_openai_chat_standard_request_from_chat_canonical_recording(&payload, &context)
            .expect("structured unknown values are omitted without rejecting mapped remainder");
    context.restamp_and_emit(&mut records);
    assert!(wire.get("client_metadata").is_none());
    assert_eq!(wire["metadata"], json!({"user_id":"client-user"}));
    assert_eq!(records.len(), 4);
    for (key, path) in [
        ("unknown", "$.client_metadata.unknown"),
        ("future.key", "$.client_metadata[\"future.key\"]"),
        (
            "bracket]quote\"",
            "$.client_metadata[\"bracket]quote\\\"\"]",
        ),
        ("", "$.client_metadata[\"\"]"),
    ] {
        let record = records
            .iter()
            .find(|r| r.json_path == path)
            .expect("correct escaped path");
        assert_eq!(record.source_value, payload["client_metadata"][key]);
        assert_eq!(record.canonical_value, payload["client_metadata"][key]);
        assert_eq!(
            record.drop_site,
            "project_openai_client_metadata_to_metadata"
        );
    }
}

#[test]
fn openai_chat_wire_projects_exact_client_metadata_user_id() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "client_metadata": {"user_id":"client-user"}
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("OpenAI Chat can project exact client_metadata.user_id");

    assert!(request.get("client_metadata").is_none(), "{request}");
    assert_eq!(request["metadata"], json!({"user_id":"client-user"}));
}

#[test]
fn openai_chat_wire_metadata_malformed_and_conflicting_controls() {
    for (client_metadata, metadata, expected) in [
        (
            json!("not-an-object"),
            Value::Null,
            "MalformedOutboundField",
        ),
        (json!({"user_id":19}), Value::Null, "MalformedOutboundField"),
        (
            json!({"user_id":null}),
            Value::Null,
            "MalformedOutboundField",
        ),
        (
            json!({"user_id":"   "}),
            Value::Null,
            "MalformedOutboundField",
        ),
        (
            json!({"user_id":"client"}),
            json!({"user_id":"other"}),
            "ConflictingOutboundFields",
        ),
        (json!({}), json!("not-an-object"), "MalformedOutboundField"),
        (json!({}), json!({"number":1}), "MalformedOutboundField"),
    ] {
        let mut payload = json!({"model":"gpt-test","messages":[{"role":"user","content":"hello"}],"client_metadata":client_metadata});
        if let Some(object) = payload["client_metadata"].as_object_mut() {
            object.insert("unknown".into(), json!({"nested":true}));
        }
        if !metadata.is_null() {
            payload["metadata"] = metadata;
        }
        let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
            .expect_err("malformed/conflicting mapping must retain its boundary");
        assert!(error.contains(expected), "{payload}: {error}");
        eprintln!("METADATA_BOUNDARY_BASELINE {payload} => {error}");
    }
}

#[test]
fn openai_chat_wire_maps_responses_text_json_schema_to_chat_response_format() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "routecodex_chat_extension": {
            "responses_request": {
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": "answer_shape",
                        "description": "Answer schema",
                        "schema": {
                            "type": "object",
                            "properties": {
                                "answer": {"type": "string"}
                            },
                            "required": ["answer"],
                            "additionalProperties": false
                        },
                        "strict": true
                    },
                    "verbosity": "low"
                }
            }
        }
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("Responses text.format json_schema must map to Chat response_format shape");

    assert_eq!(
        request["response_format"],
        json!({
            "type": "json_schema",
            "json_schema": {
                "name": "answer_shape",
                "description": "Answer schema",
                "schema": {
                    "type": "object",
                    "properties": {
                        "answer": {"type": "string"}
                    },
                    "required": ["answer"],
                    "additionalProperties": false
                },
                "strict": true
            }
        })
    );
    assert_eq!(request["verbosity"], json!("low"));
    assert!(request.get("text").is_none(), "{request}");
    assert!(
        request.get("routecodex_chat_extension").is_none(),
        "{request}"
    );
}

#[test]
fn openai_chat_wire_projects_complete_codex_tool_declaration_matrix() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "patch then search"}],
        "tools": [
            {
                "type": "function",
                "name": "exec_command",
                "description": "Run a command",
                "parameters": {"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}
            },
            {
                "type": "custom",
                "name": "apply_patch",
                "description": "Apply a patch",
                "format": {"type":"text"}
            },
            {
                "type": "tool_search",
                "execution": "client",
                "description": "Search deferred tools",
                "parameters": {"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
            },
            {
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text"],
                "search_context_size": "medium"
            }
        ]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("every Codex tool declaration must reach legal OpenAI Chat wire");

    let tools = request["tools"].as_array().expect("Chat tools array");
    assert_eq!(tools.len(), 3);
    let exec = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "exec_command")
        .unwrap();
    let patch = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "apply_patch")
        .unwrap();
    let search = tools
        .iter()
        .find(|tool| tool["function"]["name"] == "tool_search")
        .unwrap();
    assert!(tools.iter().all(|tool| tool["type"] == "function"));
    for (tool, source) in [(exec, &payload["tools"][0]), (search, &payload["tools"][2])] {
        assert_eq!(tool["function"]["description"], source["description"]);
        assert_eq!(tool["function"]["parameters"], source["parameters"]);
    }
    assert_eq!(patch["function"]["description"], "Apply a patch");
    assert_eq!(
        patch["function"]["parameters"],
        json!({
            "type":"object",
            "properties":{
                "input":{"type":"string","description":"Raw free-form tool input."}
            },
            "required":["input"],
            "additionalProperties":false
        })
    );
    assert!(patch.get("custom").is_none(), "{tools:?}");
    assert_eq!(
        request["web_search_options"]["search_context_size"],
        "medium"
    );
    assert!(!request.to_string().contains("\"type\":\"custom\""));
}

#[test]
fn openai_chat_wire_preserves_preflattened_apply_patch_function_schema() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "patch"}],
        "tools": [{
            "type": "function",
            "function": {
                "name": "apply_patch",
                "description": "The apply_patch tool",
                "parameters": {"type": "object"}
            }
        }]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("pre-flattened apply_patch must remain a legal function tool");
    assert_eq!(
        request["tools"][0]["function"]["parameters"],
        json!({
            "type":"object"
        })
    );
}

#[test]
fn openai_chat_wire_flattens_custom_tool_and_drops_extra_unmapped_fields() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "apply"}],
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "description": "Apply a patch",
            "format": {"type":"text"},
            "schema": {"type": "object"}
        }]
    });
    let (request, drops) = build_v3_openai_chat_standard_request_from_chat_canonical_recording(
        &payload,
        &V3ProjectionDropContext::disabled(),
    )
    .expect(
        "custom tool extra unmapped field must emit drop record and preserve mapped function tool",
    );
    assert_eq!(request["tools"][0]["type"], "function");
    assert_eq!(request["tools"][0]["function"]["name"], "apply_patch");
    assert!(
        request["tools"][0]["function"].get("schema").is_none(),
        "{request}"
    );
    assert!(
        drops
            .iter()
            .any(|drop| drop.json_path == "$.tools[0].schema"),
        "expected drop record for $.tools[0].schema: {drops:?}"
    );
}

#[test]
fn openai_chat_wire_omits_unknown_web_search_content_type_with_drop_record() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [{
            "type": "web_search",
            "external_web_access": true,
            "search_content_types": ["video"]
        }]
    });

    let (request, drops) = build_v3_openai_chat_standard_request_from_chat_canonical_recording(
        &payload,
        &V3ProjectionDropContext::disabled(),
    )
    .expect("unknown search_content_types element must emit drop record without blocking web_search_options");

    assert_eq!(request["web_search_options"], json!({}));
    assert!(
        drops
            .iter()
            .any(|drop| drop.json_path == "$.tools[0].search_content_types"),
        "expected drop record for $.tools[0].search_content_types: {drops:?}"
    );
}

#[test]
fn openai_chat_wire_flattens_custom_grammar_to_function_tool() {
    let payload = json!({"model": "gpt-test", "messages": [{"role": "user", "content": "patch"}], "tools": [{"type": "custom", "name": "apply_patch", "description": "Apply a patch", "format": {"type":"grammar","syntax":"lark","definition":"start: patch"}}]});

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("custom grammar must flatten to the legal OpenAI Chat function tool shape");

    assert_eq!(request["tools"][0]["type"], "function");
    assert_eq!(request["tools"][0]["function"]["name"], "apply_patch");
    assert_eq!(
        request["tools"][0]["function"]["description"],
        "Apply a patch"
    );
    assert_eq!(
        request["tools"][0]["function"]["parameters"],
        json!({
            "type":"object",
            "properties":{
                "input":{"type":"string","description":"Raw free-form tool input."}
            },
            "required":["input"],
            "additionalProperties":false
        }),
        "apply_patch requires a raw free-form input string"
    );
    assert!(request["tools"][0].get("custom").is_none(), "{request}");
}

#[test]
fn openai_chat_wire_flattens_any_custom_format_to_function_tool() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "patch"}],
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "format": {"type":"binary"}
        }]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload).expect(
        "the chat wire cannot express custom formats; every custom tool flattens to function",
    );
    assert_eq!(request["tools"][0]["type"], "function");
    assert_eq!(request["tools"][0]["function"]["name"], "apply_patch");
    assert_eq!(
        request["tools"][0]["function"]["parameters"],
        json!({
            "type":"object",
            "properties":{
                "input":{"type":"string","description":"Raw free-form tool input."}
            },
            "required":["input"],
            "additionalProperties":false
        })
    );
}

#[test]
fn openai_chat_wire_rejects_raw_responses_text_json_schema_shape() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "routecodex_chat_extension": {
            "responses_request": {
                "text": {
                    "format": {
                        "type": "json_schema",
                        "schema": {"type": "object"}
                    }
                }
            }
        }
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("Responses json_schema format without Chat-required name must fail");

    assert!(error.contains("MalformedOutboundField"), "{error}");
    assert!(error.contains("$.request.text.format.name"), "{error}");
}

#[test]
fn openai_chat_wire_projects_reasoning_summary_policy_without_wire_loss() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "medium",
        "reasoning_summary_policy": "detailed"
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("summary policy must use the registered compatible effort projection");

    assert_eq!(request["reasoning_effort"], "high");
    assert!(request.get("reasoning_summary_policy").is_none());
}

#[test]
fn openai_chat_wire_normalizes_explicit_effort_when_it_wins_summary_merge() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": " XHIGH ",
        "reasoning_summary_policy": "detailed"
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("accepted explicit effort must use the canonical wire token");

    assert_eq!(request["reasoning_effort"], "xhigh");
    assert!(request.get("reasoning_summary_policy").is_none());
}

#[test]
fn openai_chat_wire_projects_extension_reasoning_summary_policy() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "routecodex_chat_extension": {
            "responses_request": {
                "reasoning_summary_policy": "detailed"
            }
        }
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("Responses summary extension must project to Chat reasoning effort");

    assert_eq!(request["reasoning_effort"], "high");
    assert!(request.get("reasoning_summary_policy").is_none());
}

#[test]
fn openai_chat_wire_rejects_invalid_reasoning_summary_policy() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_summary_policy": "verbose"
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("invalid summary policy must fail before provider send");

    assert!(error.contains("MalformedOutboundField"), "{error}");
    assert!(error.contains("reasoning_summary_policy"), "{error}");
}

#[test]
fn openai_chat_wire_consumes_reasoning_context_policy_before_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_context_policy": "all_turns"
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("source-roundtrip context policy must be consumed before OpenAI Chat wire");

    assert!(
        request.get("reasoning_context_policy").is_none(),
        "{request}"
    );
}

#[test]
fn openai_chat_wire_consumes_extension_reasoning_context_policy() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "routecodex_chat_extension": {
            "responses_request": {
                "reasoning_context_policy": "current_turn"
            }
        }
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("Responses context extension must be consumed before OpenAI Chat wire");

    assert!(
        request.get("reasoning_context_policy").is_none(),
        "{request}"
    );
    assert!(
        request.get("routecodex_chat_extension").is_none(),
        "{request}"
    );
}

#[test]
fn openai_chat_wire_rejects_invalid_reasoning_context_policy() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_context_policy": "last_turn"
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("invalid context policy must fail before provider send");

    assert!(error.contains("MalformedOutboundField"), "{error}");
    assert!(error.contains("reasoning_context_policy"), "{error}");
}

#[test]
fn issue4a0b3aa_chat_custom_output_keeps_generated_responses_id() {
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&json!({
        "model":"gpt-test",
        "messages":[{
            "role":"tool","tool_call_id":"call_custom","content":"ok",
            "routecodex_chat_extension":{"responses_tool_output_type":"custom_tool_call_output"}
        }]
    }))
    .unwrap();
    let output = &request["input"][0];
    assert_eq!(output["type"], "custom_tool_call_output");
    assert_eq!(output["call_id"], "call_custom");
    assert!(output["id"].is_string());
}

#[test]
fn openai_chat_wire_consumes_routecodex_chat_extension_before_provider_send() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_custom",
                    "type": "function",
                    "function": {"name":"exec_command", "arguments":"{}"},
                    "routecodex_chat_extension": {"responses_tool_call_type":"custom_tool_call"}
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_custom",
                "content": "ok",
                "routecodex_chat_extension": {"responses_tool_output_type":"custom_tool_call_output"}
            }
        ]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("OpenAI Chat wire projection must consume internal chat extension");

    let serialized = request.to_string();
    assert!(
        !serialized.contains("routecodex_chat_extension"),
        "{serialized}"
    );
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["arguments"],
        "{}"
    );
    assert_eq!(request["messages"][1]["tool_call_id"], "call_custom");
}

#[test]
fn outbound_projection_allows_payload_owned_underscore_fields() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "tools": [{
            "type": "function",
            "function": {
                "name":"lookup",
                "parameters": {
                    "type":"object",
                    "properties": {"_id": {"type":"string"}}
                }
            }
        }],
        "metadata": {"_tenant":"client-owned"}
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("payload-owned underscore fields are not RouteCodex control fields");

    assert_eq!(
        request["tools"][0]["function"]["parameters"]["properties"]["_id"]["type"],
        "string"
    );
    assert_eq!(request["metadata"]["_tenant"], "client-owned");
}

#[test]
fn openai_chat_wire_preserves_same_protocol_request_fields() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "audio": {"format":"wav", "voice":"alloy"},
        "modalities": ["text", "audio"],
        "prediction": {"type":"content", "content":"expected"},
        "prompt_cache_key": "cache-key",
        "prompt_cache_options": {"ttl":"24h"},
        "prompt_cache_retention": "24h",
        "service_tier": "priority",
        "store": false,
        "web_search_options": {"search_context_size":"low"}
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("same-protocol Chat fields must reach provider wire unchanged");

    for key in [
        "audio",
        "modalities",
        "prediction",
        "prompt_cache_key",
        "prompt_cache_options",
        "prompt_cache_retention",
        "service_tier",
        "store",
        "web_search_options",
    ] {
        assert_eq!(request[key], payload[key], "field {key} drifted");
    }
}

#[test]
fn anthropic_wire_consumes_chat_store_false_without_projecting_it() {
    let payload = json!({
        "model": "claude-test",
        "messages": [{"role": "user", "content": "hello"}],
        "store": false
    });

    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Anthropic)
            .expect("store=false has the same no-storage meaning on Anthropic");
    assert!(request.get("store").is_none());
}

#[test]
fn anthropic_wire_preserves_service_tier_request_field() {
    let payload = json!({
        "model": "claude-test",
        "messages": [{"role": "user", "content": "hello"}],
        "service_tier": "priority"
    });

    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Anthropic)
            .expect("service_tier is a registered target-specific Anthropic request field");
    assert_eq!(request["service_tier"], "priority");
}

#[test]
fn anthropic_wire_omits_chat_store_true_with_drop_record() {
    let payload = json!({
        "model": "claude-test",
        "messages": [{"role": "user", "content": "hello"}],
        "store": true
    });

    let (wire, drops) = project_outbound_payload_for_target_protocol_with_drops(
        &payload,
        V3OutboundTargetProtocol::Anthropic,
    )
    .expect("store=true without Anthropic slot must warn/omit while preserving message payload");
    assert!(wire.get("store").is_none(), "{wire}");
    assert_eq!(wire["messages"][0]["content"], "hello");
    assert!(
        drops.iter().any(|drop| drop.json_path == "$.store"),
        "expected drop record for $.store: {drops:?}"
    );
}

#[test]
fn tool_search_chat_extensions_round_trip_to_responses_fields() {
    let input = build_responses_input_from_chat_messages(&[
        json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_search",
                "type": "function",
                "function": {
                    "name": "tool_search",
                    "arguments": "{\"query\":\"node repl\",\"limit\":8}"
                },
                "routecodex_chat_extension": {
                    "responses_tool_call_type": "tool_search_call",
                    "responses_status": "completed",
                    "responses_execution": "client"
                }
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_search",
            "content": "[{\"type\":\"namespace\",\"name\":\"mcp__node_repl\",\"tools\":[]}]",
            "routecodex_chat_extension": {
                "responses_tool_output_type": "tool_search_output",
                "responses_output_field": "tools",
                "responses_item_id": "tso_123",
                "responses_status": "completed",
                "responses_execution": "client"
            }
        }),
    ])
    .expect("registered Chat extensions must project back to Responses wire fields");

    assert_eq!(
        input,
        json!([
            {
                "type": "tool_search_call",
                "call_id": "call_search",
                "arguments": {"query": "node repl", "limit": 8},
                "status": "completed",
                "execution": "client"
            },
            {
                "type": "tool_search_output",
                "id": "tso_123",
                "call_id": "call_search",
                "tools": [{"type": "namespace", "name": "mcp__node_repl", "tools": []}],
                "status": "completed",
                "execution": "client"
            }
        ])
    );
}

#[test]
fn responses_wire_preserves_compacted_assistant_reasoning_without_tool_calls() {
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [
            {"role": "user", "content": "continue"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "compact reasoning must reach provider"
            }
        ]
    });

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must preserve compacted reasoning");

    assert_eq!(
        request["input"][1],
        json!({
            "type": "reasoning",
            "summary": [{
                "type": "summary_text",
                "text": "compact reasoning must reach provider"
            }]
        })
    );
    assert!(
        request["input"][1].get("text").is_none(),
        "legacy scalar reasoning_content has no Responses top-level text field: {request}"
    );
}

#[test]
fn responses_wire_keeps_ordered_reasoning_text_without_fabricating_summary() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [
            {"role": "user", "content": "continue"},
            {
                "role": "assistant",
                "content": "answer",
                "routecodex_chat_extension": {
                    "responses_reasoning_items": [
                        {
                            "id": "rsn_text_only",
                            "text": "  ordered plaintext  ",
                            "encrypted_content": "cipher"
                        },
                        {
                            "id": "rsn_empty_summary",
                            "text": "second plaintext",
                            "summary": []
                        }
                    ]
                }
            }
        ]
    });

    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("ordered Responses reasoning text must project");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    assert_eq!(
        input[1],
        json!({
            "type": "reasoning",
            "text": "  ordered plaintext  ",
            "id": "rsn_text_only",
            "encrypted_content": "cipher"
        })
    );
    assert!(
        input[1].get("summary").is_none(),
        "absent summary must not be fabricated from ordered top-level text: {request}"
    );
    assert_eq!(
        input[2],
        json!({
            "type": "reasoning",
            "text": "second plaintext",
            "id": "rsn_empty_summary"
        })
    );
    assert!(
        input[2].get("summary").is_none(),
        "empty summary must not be fabricated from ordered top-level text: {request}"
    );
    assert_eq!(input[3]["role"], json!("assistant"));
    assert_eq!(
        input[3]["content"],
        json!([{"type": "output_text", "text": "answer"}])
    );
}

#[test]
fn responses_openai_chat_field_parity_responses_wire_preserves_include_projection() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "include": ["reasoning.encrypted_content"]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    assert_eq!(request["include"], json!(["reasoning.encrypted_content"]));
}

#[test]
fn openai_responses_wire_does_not_leak_client_metadata_and_projects_reasoning_effort() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "client_metadata": {"session_id":"codex-review"},
        "reasoning_effort": "medium"
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must preserve supported protocol fields");
    assert!(request.get("client_metadata").is_none(), "{request}");
    assert!(request.get("reasoning_effort").is_none(), "{request}");
    assert!(request.get("metadata").is_none(), "{request}");
    assert_eq!(request["reasoning"], json!({"effort":"medium"}));
}
include!("request_outbound_mcp_tests.rs");
#[test]
fn openai_responses_wire_preserves_unknown_non_empty_reasoning_effort() {
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "definitely_invalid"
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("same-protocol Responses wire must preserve an unknown effort value");

    assert_eq!(request["reasoning"], json!({"effort":"definitely_invalid"}));
    assert!(request.get("reasoning_effort").is_none(), "{request}");
}

#[test]
fn openai_responses_wire_rejects_empty_reasoning_effort() {
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "   "
    });
    let error = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect_err("empty effort must not reach provider wire");

    assert_eq!(
        error,
        "MalformedOutboundField target_protocol=responses path=$.request.reasoning_effort"
    );
}

#[test]
fn openai_responses_wire_rebuilds_registered_reasoning_fields_only() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "max",
        "reasoning_summary_policy": "detailed",
        "reasoning_context_policy": "current_turn",
        "reasoning_mode": "standard"
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("registered Chat reasoning fields must project to Responses reasoning");
    assert_eq!(
        request["reasoning"],
        json!({"effort":"max","summary":"detailed","context":"current_turn","mode":"standard"})
    );
    for field in [
        "reasoning_effort",
        "reasoning_summary_policy",
        "reasoning_context_policy",
        "reasoning_mode",
    ] {
        assert!(request.get(field).is_none(), "{request}");
    }
}

#[test]
fn openai_responses_wire_drops_non_responses_reasoning_extensions() {
    for field in [
        "reasoning_budget_tokens",
        "reasoning_include_thoughts",
        "reasoning_display_policy",
        "reasoning_thinking_mode",
    ] {
        let mut payload = json!({
            "model": "gpt-test",
            "messages": [{"role": "user", "content": "hello"}]
        });
        payload
            .as_object_mut()
            .unwrap()
            .insert(field.to_string(), json!(2048));
        let wire = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
            .unwrap_or_else(|error| {
                panic!("non-Responses reasoning semantic {field} must drop, not fail: {error}")
            });
        assert!(wire.get(field).is_none(), "{field} must be dropped: {wire}");
    }
}

#[test]
fn anthropic_thinking_chat_fields_are_dropped_for_responses_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "reasoning"}],
        "reasoning_thinking_mode": "enabled",
        "reasoning_budget_tokens": 1024
    });
    let wire = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Anthropic thinking mode and numeric budget have no Responses field: drop them");
    assert!(wire.get("reasoning_thinking_mode").is_none(), "{wire}");
    assert!(wire.get("reasoning_budget_tokens").is_none(), "{wire}");
}

#[test]
fn openai_responses_metadata_limits_fail_before_wire() {
    let cases = [
        (json!({"k": 1}), "value_must_be_string"),
        (json!({"k".repeat(65): "v"}), "key_max_64"),
        (json!({"k": "v".repeat(513)}), "value_max_512"),
        (
            Value::Object(
                (0..17)
                    .map(|index| (format!("k{index}"), json!("v")))
                    .collect(),
            ),
            "max_16_pairs",
        ),
    ];
    for (metadata, expected) in cases {
        let payload = json!({
            "model": "gpt-test",
            "messages": [{"role": "user", "content": "hello"}],
            "metadata": metadata
        });
        let error = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
            .expect_err("invalid OpenAI metadata must fail before wire");
        assert!(error.contains(expected), "{error}");
    }
}

#[test]
fn codex_client_metadata_does_not_reach_responses_wire() {
    let turn_metadata = json!({
        "installation_id": "15252310-9634-460d-9809-64a631ebd187",
        "session_id": "019fbd31-bb6e-7a43-bfb2-17a1e46ec23b",
        "thread_id": "019fbd31-bb6e-7a43-bfb2-17a1e46ec23b",
        "turn_id": "019fbda6-9f13-7163-8828-2dae4bf08506",
        "window_id": "019fbd31-bb6e-7a43-bfb2-17a1e46ec23b:56",
        "request_kind": "turn",
        "forked_from_thread_id": "019fa6fd-4283-7a80-95c7-a0f3cda91c73",
        "thread_source": "user",
        "sandbox": "none",
        "workspaces": {
            "/Users/fanzhang/Documents/github/removead": {
                "latest_git_commit_hash": "87107ac2b113e07f237032690a64beab79929bb1",
                "has_changes": true
            }
        },
        "turn_started_at_unix_ms": 1785593241374_u64
    })
    .to_string();
    assert!(turn_metadata.chars().count() > 512);
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "routecodex_chat_extension": {
            "responses_request": {
                "client_metadata": {
                    "session_id": "019fbd31-bb6e-7a43-bfb2-17a1e46ec23b",
                    "x-codex-turn-metadata": turn_metadata
                }
            }
        }
    });

    let wire = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses outbound must keep client_metadata local");

    assert!(wire.get("client_metadata").is_none(), "{wire}");
    assert!(wire.get("metadata").is_none(), "{wire}");
}

#[test]
fn relay_responses_wire_omits_unconsumed_previous_response_id_with_drop_record() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "previous_response_id": "unsupported_previous_response_id"
    });
    let (wire, drops) = build_v3_openai_responses_standard_request_for_selected_target_with_drops(
        &payload, true,
    )
    .expect("unconsumed previous_response_id must emit drop record and omit instead of aborting Relay outbound");
    assert!(wire.get("previous_response_id").is_none(), "{wire}");
    assert_eq!(wire["input"][0]["content"][0]["text"], "hello");
    assert!(
        drops
            .iter()
            .any(|drop| drop.json_path == "$.previous_response_id"),
        "expected drop record for $.previous_response_id: {drops:?}"
    );
}

#[test]
fn relay_responses_wire_preserves_non_continuation_provider_fields() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "safety_identifier": "safety-client",
        "moderation": {"mode":"auto"},
        "stream_options": {"include_obfuscation":false}
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("ordinary Responses provider fields must survive Relay projection");
    assert_eq!(request["safety_identifier"], "safety-client");
    assert_eq!(request["moderation"], json!({"mode":"auto"}));
    assert_eq!(
        request["stream_options"],
        json!({"include_obfuscation":false})
    );
}

#[test]
fn gemini_wire_consumes_stream_as_transport_intent() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "generationConfig": {
            "thinkingConfig": {
                "includeThoughts": true,
                "thinkingBudget": 4096
            }
        },
        "stream": false
    });

    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("Gemini outbound must consume stream as transport intent");

    assert!(request.get("stream").is_none(), "{request}");
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/includeThoughts"),
        Some(&json!(true))
    );
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/thinkingBudget"),
        Some(&json!(4096))
    );
}

#[test]
fn gemini_wire_rejects_malformed_stream_transport_intent() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "stream": "false"
    });

    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini stream transport intent must remain boolean");

    assert!(error.contains("$.request.stream"), "{error}");
}

#[test]
fn openai_chat_wire_keeps_hosted_options_for_gpt_with_capability() {
    // gpt 系列模型 + provider 具备 web_search 能力：保留标准 hosted
    // web_search_options 投影（与 HEAD 行为一致）。
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text"]
            }
        ]
    });
    let request = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::None,
        true,
    )
    .expect("gpt + capability keeps the hosted options projection");
    assert!(
        request.get("tools").is_none(),
        "web_search declaration must be consumed by options (no residual tools)"
    );
    assert!(
        request
            .get("web_search_options")
            .is_some_and(Value::is_object),
        "gpt + capability must keep the hosted web_search_options projection"
    );
}

#[test]
fn openai_chat_wire_removes_web_search_for_gpt_without_capability() {
    // gpt 系列模型 + provider 无 web_search 能力（如 deepseek，capabilities
    // 不含 web_search）：web_search 工具声明与 web_search_options 完全移除，
    // 避免把未知字段/工具发给无能力 provider。
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "web_search",
                "search_context_size": "medium"
            },
            {"type": "function", "function": {"name": "read_file"}}
        ]
    });
    let request = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::None,
        false,
    )
    .expect("no-capability provider must strip web_search cleanly");
    assert!(
        request.get("web_search_options").is_none(),
        "no-capability provider must not receive web_search_options: {:?}",
        request.get("web_search_options")
    );
    // 普通 function 工具（read_file）保留，web_search 声明完全移除。
    let tools = request["tools"].as_array().expect("tools retained");
    assert_eq!(tools.len(), 1, "ordinary function tool must remain");
    assert_eq!(tools[0]["function"]["name"], "read_file");
    assert!(
        !tools.iter().any(|tool| tool
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "web_search")),
        "web_search tool declaration must be removed"
    );
}

#[test]
fn openai_chat_wire_mode_a_removes_web_search_for_provider_without_capability() {
    // Mode A（NativeRemoteSearchToolMix）与 Mode B 共用 capability 护栏：
    // provider 未声明 web_search 能力时 hosted web_search 声明一并移除，
    // 不能因为请求级 Mode A 就无条件保留。
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text", "image"]
            },
            {"type": "function", "function": {"name": "read_file"}}
        ]
    });
    let request = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        false,
    )
    .expect("Mode A without capability must strip web_search cleanly");
    assert!(
        request.get("web_search_options").is_none(),
        "no-capability provider must not receive web_search_options under Mode A: {:?}",
        request.get("web_search_options")
    );
    let tools = request["tools"].as_array().expect("tools retained");
    assert_eq!(tools.len(), 1, "ordinary function tool must remain");
    assert_eq!(tools[0]["function"]["name"], "read_file");
    assert!(
        !tools.iter().any(|tool| tool
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "web_search")),
        "web_search tool declaration must be removed under Mode A without capability"
    );
}

#[test]
fn openai_chat_wire_accepts_standard_text_image_search_content_types() {
    // Codex 标准 web_search 声明携带 search_content_types ["text","image"]
    // （生产样本 tools[13]）。openai_chat hosted web_search 只能表达文本结果：
    // image 是已知合法内容类型但协议无法表达 → 显式剥离（降级 text 投影），
    // 不得 fail-fast 502。
    let payload = json!({
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text", "image"]
            }
        ]
    });
    let request = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
    )
    .expect("standard Codex text+image declaration must project to openai_chat wire");
    assert!(
        request.get("web_search_options").is_some(),
        "capable provider under Mode A must receive web_search_options: {:?}",
        request
    );
}

#[test]
fn openai_chat_wire_removes_websearch_for_non_gpt_without_capability() {
    // 无 hosted 能力且未配本地搜索时，default 目标只保留普通函数工具。
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text"]
            },
            {"type": "function", "function": {"name": "read_file"}}
        ]
    });
    let request = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::None,
        false,
    )
    .expect("default provider must keep ordinary tools");
    assert!(
        request.get("web_search_options").is_none(),
        "non-gpt provider must not receive hosted web_search_options"
    );
    let tools = request["tools"].as_array().expect("tools retained");
    assert_eq!(tools.len(), 1, "only read_file must remain");
    assert_eq!(tools[0]["function"]["name"], "read_file");
}

#[test]
fn continuation_history_prefix_renders_byte_identical_across_requests() {
    let history = vec![
        json!({"role": "user", "content": [
            {"type": "text", "text": "The history question with a screenshot attached"},
            {"type": "text", "text": "[Image]"}
        ]}),
        json!({"role": "assistant", "content": "I can see the image in the history."}),
    ];
    let build_wire = |current: &str| {
        let mut messages = history.clone();
        messages.push(json!({"role": "user", "content": current}));
        build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
            "model": "deepseek-v4-flash",
            "messages": messages
        }))
        .expect("OpenAI Chat wire build")
    };
    let wire_a = build_wire("Reply with exactly: CONTINUE_A");
    let wire_b = build_wire("Reply with exactly: CONTINUE_B");
    assert_eq!(
        wire_a["messages"].as_array().unwrap()[..2],
        wire_b["messages"].as_array().unwrap()[..2],
        "history prefix must render byte-identical for the continuation cache"
    );
    assert_ne!(wire_a["messages"][2], wire_b["messages"][2]);
}

#[test]
fn openai_chat_wire_leaves_normal_history_without_synthetic_followup() {
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"}
        ]
    });
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("OpenAI Chat wire build");
    assert_eq!(request["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn continuation_assistant_reasoning_round_trips_to_wire_reasoning_content() {
    let reasoning =
        "1. The user asks to reply with exactly CONTINUE_B. No other content is needed.";
    let payload = json!({
        "model": "deepseek-v4-flash",
        "messages": [
            {"role": "user", "content": "Reply with exactly: CONTINUE_A"},
            {"role": "assistant", "content": "CONTINUE_A", "reasoning_content": reasoning},
            {"role": "user", "content": "Reply with exactly: CONTINUE_B"}
        ]
    });
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("OpenAI Chat wire build");
    assert_eq!(
        request["messages"][1]["reasoning_content"], reasoning,
        "client-echoed assistant reasoning must pass to wire reasoning_content untouched"
    );
    assert_eq!(request["messages"][1]["content"], "CONTINUE_A");
}

include!("request_outbound_gemini_canonical_consumer_tests.rs");
#[test]
fn anthropic_system_extension_consumes_text_without_replaying_or_dropping_residuals() {
    for responses_request in [None, Some(json!({"store":false}))] {
        let mut source = json!({"model":"chat-model","messages":[
            {"role":"system","content":"governed guidance"},{"role":"user","content":"hello"}
        ],"routecodex_chat_extension":{
            "anthropic_request":{"system":[
                {"type":"text","text":"old guidance","cache_control":{"type":"ephemeral"}},
                {"type":"future_system_part","payload":{"keep":[1,2]}}
            ],"extra":{"keep":true}},"future_namespace":{"value":7}
        }});
        if let Some(value) = responses_request {
            source["routecodex_chat_extension"]["responses_request"] = value;
        }
        let original = source.clone();
        let wire = build_v3_openai_chat_standard_request_from_chat_canonical(&source)
            .expect("known system mapping must not reject retained business extensions");
        assert_eq!(wire["messages"], source["messages"]);
        assert_eq!(
            wire["routecodex_chat_extension"]["future_namespace"],
            json!({"value":7})
        );
        let residual = &wire["routecodex_chat_extension"]["anthropic_request"];
        assert!(residual["system"][0].get("text").is_none());
        assert_eq!(
            residual["system"][0]["cache_control"],
            json!({"type":"ephemeral"})
        );
        assert_eq!(
            residual["system"][1],
            original["routecodex_chat_extension"]["anthropic_request"]["system"][1]
        );
        assert_eq!(residual["extra"], json!({"keep":true}));
        assert_eq!(source, original);
    }
}

#[test]
fn openai_chat_builtin_tool_projection_rejects_malformed_types_before_drop() {
    let bad_external = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [{"type": "web_search", "external_web_access": "yes"}]
    });
    let err = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &bad_external,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
    )
    .expect_err("non-bool external_web_access must remain MalformedOutboundField");
    assert!(err.contains("external_web_access"), "{err}");

    let bad_content_types = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [{"type": "web_search", "search_content_types": ["text", 123]}]
    });
    let err = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &bad_content_types,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
    )
    .expect_err("non-string member in search_content_types must fail MalformedOutboundField");
    assert!(err.contains("search_content_types"), "{err}");

    let bad_tool_search_exec = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "search tools"}],
        "tools": [{"type": "tool_search", "execution": 7}]
    });
    let err = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &bad_tool_search_exec,
        V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
        true,
    )
    .expect_err("non-string tool_search.execution must fail MalformedOutboundField");
    assert!(err.contains("execution"), "{err}");

    let (text_image_wire, text_image_drops) =
        build_v3_openai_chat_standard_request_for_selected_web_search_mode_recording(
            &json!({
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "search"}],
                "tools": [{
                    "type": "web_search",
                    "external_web_access": true,
                    "search_content_types": ["text", "image"]
                }]
            }),
            V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
            true,
            &crate::projection_drop_log::V3ProjectionDropContext::disabled(),
        )
        .expect("standard text+image search_content_types must project web_search_options cleanly");
    assert!(text_image_wire.get("web_search_options").is_some());
    assert!(
        text_image_drops
            .iter()
            .any(|drop| drop.json_path == "$.tools[0].search_content_types"),
        "image search_content_types omission must emit scoped drop record: {text_image_drops:?}"
    );

    let (offline_search_wire, offline_search_drops) =
        build_v3_openai_chat_standard_request_for_selected_web_search_mode_recording(
            &json!({
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "search"}],
                "tools": [
                    {"type": "web_search", "external_web_access": false, "search_context_size": "high"},
                    {"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}
                ],
                "tool_choice": {"type": "web_search"}
            }),
            V3WebSearchExecutionMode::NativeRemoteSearchToolMix,
            true,
            &crate::projection_drop_log::V3ProjectionDropContext::disabled(),
        )
        .expect("external_web_access=false must omit hosted web_search cleanly without blocking remaining tools");
    assert!(
        offline_search_wire.get("web_search_options").is_none(),
        "external_web_access=false must not emit web_search_options (would enable live search): {offline_search_wire}"
    );
    assert!(
        offline_search_wire.get("tool_choice").is_none(),
        "hosted web_search tool_choice must be removed alongside external_web_access=false: {offline_search_wire}"
    );
    assert_eq!(offline_search_wire["tools"].as_array().unwrap().len(), 1);
    assert!(
        offline_search_drops
            .iter()
            .any(|drop| drop.json_path == "$.tools[0]"),
        "expected drop record for omitted external_web_access=false web_search: {offline_search_drops:?}"
    );
    assert!(
        offline_search_drops
            .iter()
            .any(|drop| drop.json_path == "$.tool_choice"),
        "expected drop record for removed hosted web_search tool_choice: {offline_search_drops:?}"
    );

    let (server_tool_search_wire, server_tool_search_drops) =
        build_v3_openai_chat_standard_request_from_chat_canonical_recording(
            &json!({
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "search"}],
                "tools": [
                    {"type": "tool_search", "execution": "server"},
                    {"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}
                ],
                "tool_choice": {"type": "tool_search"}
            }),
            &crate::projection_drop_log::V3ProjectionDropContext::disabled(),
        )
        .expect("server-executed tool_search without Chat target must be omitted cleanly");
    assert!(
        server_tool_search_wire["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool["function"]["name"] != "tool_search"),
        "server-executed tool_search must not become client-callable function: {server_tool_search_wire}"
    );
    assert!(server_tool_search_wire.get("tool_choice").is_none());
    assert!(
        server_tool_search_drops
            .iter()
            .any(|drop| drop.json_path == "$.tools[0]"),
        "expected drop record for unrepresentable server tool_search: {server_tool_search_drops:?}"
    );

    let (mixed_fn_wire, mixed_fn_drops) =
        build_v3_openai_chat_standard_request_from_chat_canonical_recording(
            &json!({
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "search"}],
                "tools": [
                    {"type": "tool_search", "execution": "server"},
                    {"type": "function", "function": {"name": "tool_search", "parameters": {"type": "object"}}}
                ],
                "tool_choice": {"type": "function", "function": {"name": "tool_search"}}
            }),
            &crate::projection_drop_log::V3ProjectionDropContext::disabled(),
        )
        .expect("omitting hosted server tool_search must preserve colocated function named tool_search and its forced tool_choice");
    let mixed_tools = mixed_fn_wire["tools"].as_array().unwrap();
    assert_eq!(mixed_tools.len(), 1, "{mixed_fn_wire}");
    assert_eq!(mixed_tools[0]["function"]["name"], "tool_search");
    assert_eq!(
        mixed_fn_wire["tool_choice"],
        json!({"type": "function", "function": {"name": "tool_search"}}),
        "ordinary function tool_choice must be preserved when hosted tool_search is omitted: {mixed_fn_wire}"
    );
    assert!(
        mixed_fn_drops
            .iter()
            .any(|drop| drop.json_path == "$.tools[0]"),
        "{mixed_fn_drops:?}"
    );
    assert!(
        !mixed_fn_drops
            .iter()
            .any(|drop| drop.json_path == "$.tool_choice"),
        "ordinary function tool_choice must not be dropped: {mixed_fn_drops:?}"
    );

    let (hosted_only_required_wire, hosted_only_required_drops) =
        build_v3_openai_chat_standard_request_from_chat_canonical_recording(
            &json!({
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "search"}],
                "tools": [{"type": "tool_search", "execution": "server"}],
                "tool_choice": "required"
            }),
            &crate::projection_drop_log::V3ProjectionDropContext::disabled(),
        )
        .expect("hosted-only tool_search with required tool_choice must omit orphaned choice");
    assert!(hosted_only_required_wire.get("tools").is_none());
    assert!(
        hosted_only_required_wire.get("tool_choice").is_none(),
        "orphaned required tool_choice must be omitted when no callable tools remain: {hosted_only_required_wire}"
    );
    assert!(
        hosted_only_required_drops
            .iter()
            .any(|drop| drop.json_path == "$.tool_choice"),
        "{hosted_only_required_drops:?}"
    );

    let (mixed_required_wire, mixed_required_drops) =
        build_v3_openai_chat_standard_request_from_chat_canonical_recording(
            &json!({
                "model": "gpt-5.5",
                "messages": [{"role": "user", "content": "lookup"}],
                "tools": [
                    {"type": "tool_search", "execution": "server"},
                    {"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}
                ],
                "tool_choice": "required"
            }),
            &crate::projection_drop_log::V3ProjectionDropContext::disabled(),
        )
        .expect("hosted tool_search alongside callable tool must retain required tool_choice");
    assert_eq!(mixed_required_wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(mixed_required_wire["tool_choice"], "required");
    assert!(
        !mixed_required_drops
            .iter()
            .any(|drop| drop.json_path == "$.tool_choice"),
        "{mixed_required_drops:?}"
    );
}
