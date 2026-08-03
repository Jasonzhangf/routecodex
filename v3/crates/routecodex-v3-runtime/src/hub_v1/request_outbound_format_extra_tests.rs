use super::*;

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
fn responses_openai_chat_field_parity_responses_wire_generates_collision_resistant_fc_ids() {
    let repeated_prefix = "call_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv";
    let payload = json!({
        "model": "gpt-test",
        "messages": [{
            "role": "assistant",
            "content": null,
            "tool_calls": [
                {"id": format!("{repeated_prefix}_left"), "type": "function", "function": {"name": "exec_command", "arguments": "{}"}},
                {"id": format!("{repeated_prefix}_right"), "type": "function", "function": {"name": "exec_command", "arguments": "{}"}}
            ]
        }]
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must succeed");
    let input = request["input"]
        .as_array()
        .expect("Responses wire input array");
    assert_ne!(input[0]["id"], input[1]["id"]);
    for item in input {
        assert!(item["id"].as_str().unwrap().starts_with("fc_"));
        assert!(item["id"].as_str().unwrap().len() <= 64);
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
fn responses_openai_chat_field_parity_include_is_rejected_from_chat_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "include": ["reasoning.encrypted_content"]
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("OpenAI Chat wire projection must reject unmapped Responses include");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(error.contains("target_protocol=openai_chat"), "{error}");
    assert!(error.contains("$.include"), "{error}");
}

#[test]
fn outbound_projection_rejects_control_fields_with_precise_path() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": [{"type":"text", "text":"hello", "_debug": true}]}],
        "metadata_center": {"route": "internal"}
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("control fields must fail before provider send");

    assert!(error.contains("ControlFieldLeak"), "{error}");
    assert!(error.contains("$.metadata_center"), "{error}");
    assert!(error.contains("$.messages[0].content[0]._debug"), "{error}");
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
fn openai_chat_wire_rejects_unknown_client_metadata_before_provider_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "client_metadata": {"unknown":{"nested":true}}
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("client metadata projected to OpenAI Chat metadata must be string-valued");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(
        error.contains("$.request.client_metadata.unknown"),
        "{error}"
    );
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
fn openai_chat_wire_projects_responses_web_search_tool_to_options() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "function",
                "name": "read_file",
                "description": "Read one file",
                "parameters": {"type":"object","properties":{}}
            },
            {
                "type": "web_search_preview",
                "search_context_size": "medium",
                "user_location": {
                    "type": "approximate",
                    "country": "CN",
                    "city": "Shanghai"
                }
            },
            {
                "type": "tool_search",
                "execution": "client",
                "description": "Search deferred tools",
                "parameters": {
                    "type":"object",
                    "properties":{"query":{"type":"string"}},
                    "required":["query"],
                    "additionalProperties":false
                }
            }
        ]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("Responses web search must project to Chat web_search_options");

    assert_eq!(request["tools"].as_array().map(Vec::len), Some(2));
    assert_eq!(request["tools"][0]["function"]["name"], json!("read_file"));
    assert_eq!(
        request["tools"][1]["function"]["name"],
        json!("tool_search")
    );
    assert_eq!(
        request["web_search_options"],
        json!({
            "search_context_size":"medium",
            "user_location": {
                "type":"approximate",
                "country":"CN",
                "city":"Shanghai"
            }
        })
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
    assert_eq!(tools[0]["function"]["name"], "exec_command");
    assert_eq!(tools[1]["type"], "custom");
    assert_eq!(tools[1]["custom"]["name"], "apply_patch");
    assert_eq!(tools[1]["custom"]["description"], "Apply a patch");
    assert_eq!(tools[1]["custom"]["format"], json!({"type":"text"}));
    assert!(tools[1].get("function").is_none(), "{tools:?}");
    assert_eq!(tools[2]["function"]["name"], "tool_search");
    assert_eq!(
        request["web_search_options"]["search_context_size"],
        "medium"
    );
    assert!(request.to_string().contains("\"type\":\"custom\""));
}

#[test]
fn openai_chat_wire_rejects_unknown_web_search_content_type() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [{
            "type": "web_search",
            "external_web_access": true,
            "search_content_types": ["video"]
        }]
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("unknown search content type must fail before provider send");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(error.contains("$.tools[0].search_content_types"), "{error}");
}

#[test]
fn openai_chat_wire_projects_custom_grammar_to_native_chat_custom_tool() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "patch"}],
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "format": {"type":"grammar","syntax":"lark","definition":"start: patch"}
        }]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("custom grammar must use the native OpenAI Chat custom tool shape");

    assert_eq!(request["tools"][0]["type"], "custom");
    assert_eq!(request["tools"][0]["custom"]["name"], "apply_patch");
    assert_eq!(
        request["tools"][0]["custom"]["format"],
        json!({
            "type":"grammar",
            "grammar":{"syntax":"lark","definition":"start: patch"}
        })
    );
    assert!(request["tools"][0].get("function").is_none(), "{request}");
}

#[test]
fn openai_chat_wire_rejects_unknown_custom_format_without_function_downgrade() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "patch"}],
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "format": {"type":"binary"}
        }]
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("unknown custom format must fail instead of becoming a function tool");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(error.contains("$.tools[0].format.type"), "{error}");
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
fn openai_chat_wire_rejects_unmapped_reasoning_summary_policy() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "reasoning_effort": "medium",
        "reasoning_summary_policy": "detailed"
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("OpenAI Chat has no equivalent reasoning summary policy");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(error.contains("reasoning_summary_policy"), "{error}");
}

#[test]
fn openai_chat_wire_rejects_extension_reasoning_summary_policy() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "routecodex_chat_extension": {
            "responses_request": {
                "reasoning_summary_policy": "detailed"
            }
        }
    });

    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("Responses summary policy extension must not disappear on Chat wire");

    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(
        error.contains("$.request.reasoning_summary_policy"),
        "{error}"
    );
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
fn openai_responses_wire_preserves_client_metadata_and_projects_reasoning_effort() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "client_metadata": {"session_id":"codex-review"},
        "reasoning_effort": "medium"
    });
    let request = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("Responses wire projection must preserve supported protocol fields");
    assert_eq!(
        request["client_metadata"],
        json!({"session_id":"codex-review"})
    );
    assert!(request.get("reasoning_effort").is_none(), "{request}");
    assert!(request.get("metadata").is_none(), "{request}");
    assert_eq!(request["reasoning"], json!({"effort":"medium"}));
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
fn openai_responses_wire_rejects_non_responses_reasoning_extensions() {
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
        let error = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
            .expect_err("non-Responses reasoning semantic must be unmapped");
        assert!(error.contains(field), "{error}");
    }
}

#[test]
fn anthropic_thinking_chat_fields_are_unmapped_for_responses_wire() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "reasoning"}],
        "reasoning_thinking_mode": "enabled",
        "reasoning_budget_tokens": 1024
    });
    let error = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect_err("Anthropic thinking mode and numeric budget have no Responses field");
    assert!(error.contains("reasoning_thinking_mode"), "{error}");
    assert!(error.contains("reasoning_budget_tokens"), "{error}");
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
fn codex_client_metadata_remains_client_metadata_on_responses_wire() {
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
        .expect("Responses outbound must preserve the distinct client_metadata field");

    assert_eq!(
        wire["client_metadata"]["x-codex-turn-metadata"],
        turn_metadata
    );
    assert_eq!(
        wire["client_metadata"]["session_id"],
        "019fbd31-bb6e-7a43-bfb2-17a1e46ec23b"
    );
    assert!(wire.get("metadata").is_none(), "{wire}");
}

#[test]
fn relay_responses_wire_rejects_unconsumed_previous_response_id() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "hello"}],
        "previous_response_id": "resp_must_be_resolved_at_req03"
    });
    let error = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect_err("continuation owner state must not cross into Relay outbound");
    assert!(error.contains("UnmappedOutboundFields"), "{error}");
    assert!(error.contains("$.previous_response_id"), "{error}");
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
