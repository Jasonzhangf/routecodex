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
    assert_eq!(tools[1]["type"], "function");
    assert_eq!(tools[1]["function"]["name"], "apply_patch");
    assert_eq!(tools[1]["function"]["description"], "Apply a patch");
    assert_eq!(tools[1]["function"]["parameters"], json!({"type":"object"}));
    assert!(tools[1].get("custom").is_none(), "{tools:?}");
    assert_eq!(tools[2]["function"]["name"], "tool_search");
    assert_eq!(
        request["web_search_options"]["search_context_size"],
        "medium"
    );
    assert!(!request.to_string().contains("\"type\":\"custom\""));
}

#[test]
fn openai_chat_wire_rejects_unknown_custom_format_without_function_downgrade() {
    // custom 工具含非 type/name/description/format 字段：拒绝（UnmappedOutboundFields），
    // 禁止降级为 function 静默丢失（opencode-go 等上游以 unknown variant 'custom' 拒绝）。
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
    let error = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect_err("custom tool with unmapped field must be rejected, not downgraded");
    let message = error.to_string();
    assert!(
        message.contains("UnmappedOutboundFields") && message.contains("schema"),
        "unexpected rejection: {message}"
    );
    assert!(!message.contains("function"), "must not fall back to function: {message}");
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
fn openai_chat_wire_flattens_custom_grammar_to_function_tool() {
    let payload = json!({
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "patch"}],
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "description": "Apply a patch",
            "format": {"type":"grammar","syntax":"lark","definition":"start: patch"}
        }]
    });

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("custom grammar must flatten to the legal OpenAI Chat function tool shape");

    assert_eq!(request["tools"][0]["type"], "function");
    assert_eq!(request["tools"][0]["function"]["name"], "apply_patch");
    assert_eq!(request["tools"][0]["function"]["description"], "Apply a patch");
    assert_eq!(
        request["tools"][0]["function"]["parameters"],
        json!({"type":"object"}),
        "go requires parameters to be a JSON Schema with type object"
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

    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&payload)
        .expect("the chat wire cannot express custom formats; every custom tool flattens to function");
    assert_eq!(request["tools"][0]["type"], "function");
    assert_eq!(request["tools"][0]["function"]["name"], "apply_patch");
    assert_eq!(
        request["tools"][0]["function"]["parameters"],
        json!({"type":"object"})
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
fn openai_chat_wire_projects_local_websearch_tool_for_metadata_center_local_search() {
    let payload = json!({
        "model": "local-model",
        "messages": [{"role": "user", "content": "search"}],
        "tools": [
            {
                "type": "function",
                "name": "read_file",
                "description": "Read one file",
                "parameters": {"type":"object","properties":{}}
            },
            {
                "type": "web_search",
                "external_web_access": true,
                "search_content_types": ["text"],
                "search_context_size": "medium"
            }
        ]
    });
    let request = build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &payload,
        V3WebSearchExecutionMode::MetadataCenterLocalSearch,
        true,
    )
    .expect("Mode B local websearch projection must compile");
    let tools = request["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 2, "ordinary tools must remain unchanged");
    assert_eq!(tools[0]["function"]["name"], "read_file");
    assert_eq!(tools[0]["function"]["parameters"]["type"], "object");
    assert_eq!(tools[1]["type"], "function");
    assert_eq!(
        tools[1]["function"]["name"], "websearch",
        "Mode B must use the single local tool name websearch"
    );
    assert_eq!(
        tools[1]["function"]["parameters"]["required"][0], "query",
        "local websearch must require the query argument"
    );
    let description = tools[1]["function"]["description"]
        .as_str()
        .expect("websearch tool description");
    assert_eq!(
        description, "Search the web for up-to-date information.",
        "websearch description must match the standard web_search tool description: {description}"
    );
    let query_description = tools[1]["function"]["parameters"]["properties"]["query"]
        ["description"]
        .as_str()
        .expect("websearch query description");
    assert!(
        query_description.contains("concise query"),
        "websearch query description must guide the search query: {query_description}"
    );
    assert!(
        !description.contains("RouteCodex") && !description.contains("ServerTool"),
        "websearch description must not leak internal RouteCodex implementation: {description}"
    );
    assert!(
        request.get("web_search_options").is_none(),
        "Mode B must not emit hosted web_search_options"
    );
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
fn openai_chat_wire_projects_local_websearch_for_non_gpt_without_mode() {
    // 非 gpt 模型（deepseek/plain-model 等）即使未配 Mode B（None）：标准
    // web_search 声明统一替换为内部 websearch 工具（不区分 provider、不依赖
    // provider 原生搜索能力——搜索由 RouteCodex 本地 hop 执行）。
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
    .expect("non-gpt provider must project the local websearch tool");
    assert!(
        request.get("web_search_options").is_none(),
        "non-gpt provider must not receive hosted web_search_options"
    );
    let tools = request["tools"].as_array().expect("tools retained");
    let websearch = tools
        .iter()
        .find(|tool| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                == Some("websearch")
        })
        .expect("non-gpt provider must receive the local websearch tool");
    assert_eq!(
        websearch["function"]["description"],
        "Search the web for up-to-date information."
    );
    assert_eq!(
        tools.len(),
        2,
        "read_file + local websearch must both remain"
    );
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
fn continuation_assistant_reasoning_round_trips_to_wire_reasoning_content() {
    let reasoning = "1. The user asks to reply with exactly CONTINUE_B. No other content is needed.";
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
        request["messages"][1]["reasoning_content"],
        reasoning,
        "client-echoed assistant reasoning must pass to wire reasoning_content untouched"
    );
    assert_eq!(request["messages"][1]["content"], "CONTINUE_A");
}
