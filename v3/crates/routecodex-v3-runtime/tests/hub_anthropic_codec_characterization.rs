use routecodex_v3_runtime::{
    characterize_v3_anthropic_client_input_to_hub_semantic,
    characterize_v3_anthropic_hub_response_semantic_to_client_projection,
    characterize_v3_anthropic_hub_semantic_to_provider_wire,
    characterize_v3_anthropic_provider_raw_to_hub_response_semantic,
    collect_v3_anthropic_request_shape_branch_semantics,
    encode_v3_anthropic_request_as_responses_semantic,
    encode_v3_responses_semantic_as_anthropic_request,
    project_v3_anthropic_message_as_responses_response,
    project_v3_anthropic_message_as_responses_response_with_context,
    V3AnthropicChatShapeBranchSemantic, V3AnthropicCodecError, V3AnthropicCodecStage,
    V3AnthropicResponsesProjectionContext, V3HubEntryProtocol, V3HubProviderWireProtocol,
    V3HubTransportIntent,
};
use serde_json::json;

#[test]
fn request_characterization_preserves_anthropic_json_tool_result_and_reasoning_shape() {
    let client = json!({
        "model": "claude-sonnet",
        "system": [{"type":"text","text":"be exact"}],
        "messages": [
            {"role":"user","content":[{"type":"text","text":"hi"}]},
            {"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"q":"x"}}]},
            {"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}
        ],
        "tools": [{"name":"lookup","input_schema":{"type":"object"}}],
        "thinking": {"type":"enabled","budget_tokens":1024},
        "stream": false
    });
    let semantic = characterize_v3_anthropic_client_input_to_hub_semantic(
        client.clone(),
        V3HubEntryProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &client);
    assert_eq!(
        semantic.trace().stage,
        V3AnthropicCodecStage::ClientInputToHubSemantic
    );

    let wire = characterize_v3_anthropic_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &client);
    assert_eq!(wire.payload()["messages"], client["messages"]);
    assert_eq!(wire.payload()["tools"], client["tools"]);
    assert_eq!(wire.payload()["thinking"], client["thinking"]);
    assert!(wire.payload().get("anthropic_version").is_none());
    assert_eq!(
        wire.trace().stage,
        V3AnthropicCodecStage::HubSemanticToProviderWire
    );
}

fn anthropic_image_shape_request() -> serde_json::Value {
    json!({
        "model": "claude-sonnet",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "url", "url": "https://example.test/cat.png"}},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERi0x"}}
            ]
        }]
    })
}

#[test]
fn anthropic_image_source_url_maps_only_to_chat_image_url_url() {
    let semantics = collect_v3_anthropic_request_shape_branch_semantics(
        &anthropic_image_shape_request(),
        V3HubEntryProtocol::Anthropic,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatImageUrlUrl
        && semantic.source_field == "request.messages[].content[].image.source.url"
        && semantic.value == "https://example.test/cat.png"));
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatInlineMediaData
        && semantic.source_field == "request.messages[].content[].image.source.url"));
}

#[test]
fn anthropic_image_base64_data_maps_to_chat_inline_media_data() {
    let semantics = collect_v3_anthropic_request_shape_branch_semantics(
        &anthropic_image_shape_request(),
        V3HubEntryProtocol::Anthropic,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatInlineMediaData
        && semantic.source_field == "request.messages[].content[].image.source.data"
        && semantic.value == "iVBORw0KGgo="));
}

#[test]
fn anthropic_image_base64_media_type_maps_to_chat_media_mime_type() {
    let semantics = collect_v3_anthropic_request_shape_branch_semantics(
        &anthropic_image_shape_request(),
        V3HubEntryProtocol::Anthropic,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatMediaMimeType
        && semantic.source_field == "request.messages[].content[].image.source.media_type"
        && semantic.value == "image/png"));
}

#[test]
fn anthropic_image_url_does_not_map_to_inline_media_data() {
    let semantics = collect_v3_anthropic_request_shape_branch_semantics(
        &anthropic_image_shape_request(),
        V3HubEntryProtocol::Anthropic,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatInlineMediaData
        && semantic.source_field == "request.messages[].content[].image.source.url"));
}

#[test]
fn anthropic_image_base64_data_does_not_map_to_chat_media_mime_type() {
    let semantics = collect_v3_anthropic_request_shape_branch_semantics(
        &anthropic_image_shape_request(),
        V3HubEntryProtocol::Anthropic,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatMediaMimeType
        && semantic.source_field == "request.messages[].content[].image.source.data"));
}

#[test]
fn anthropic_image_base64_does_not_collapse_to_chat_image_url_url() {
    let semantics = collect_v3_anthropic_request_shape_branch_semantics(
        &anthropic_image_shape_request(),
        V3HubEntryProtocol::Anthropic,
    )
    .unwrap();
    assert!(!semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatImageUrlUrl
        && semantic.source_field == "request.messages[].content[].image.source.data"));
}

#[test]
fn anthropic_document_base64_data_maps_to_chat_file_file_data() {
    let semantics = collect_v3_anthropic_request_shape_branch_semantics(
        &anthropic_image_shape_request(),
        V3HubEntryProtocol::Anthropic,
    )
    .unwrap();
    assert!(semantics.iter().any(|semantic| semantic.chat_semantic
        == V3AnthropicChatShapeBranchSemantic::ChatFileFileData
        && semantic.source_field == "request.messages[].content[].document.source.data"
        && semantic.value == "JVBERi0x"));
}

#[test]
fn anthropic_image_shape_branch_semantics_do_not_mutate_provider_wire_payload() {
    let request = anthropic_image_shape_request();
    let semantic = characterize_v3_anthropic_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let wire = characterize_v3_anthropic_hub_semantic_to_provider_wire(semantic).unwrap();
    assert_eq!(wire.payload(), &request);
}

#[test]
fn openai_chat_image_url_part_projects_to_anthropic_base64_image() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"claude-fable-5",
        "stream": false,
        "messages": [{
            "role":"user",
            "content": [
                {"type":"text","text":"describe"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA","detail":"high"}}
            ]
        }]
    }))
    .expect("Chat-native image_url must map to Anthropic image content");

    assert_eq!(
        provider_request["messages"][0]["content"][1],
        json!({
            "type":"image",
            "source":{"type":"base64","media_type":"image/png","data":"AAAA"}
        })
    );
}

#[test]
fn responses_custom_tool_call_raw_input_encodes_as_anthropic_tool_use_object() {
    let raw_patch = "*** Begin Patch\n*** Update File: project.private.config.json\n@@\n-}\n+}\n*** End Patch\n";
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"apply patch"}]
            },
            {
                "type":"custom_tool_call",
                "call_id":"call_patch",
                "name":"apply_patch",
                "input": raw_patch
            },
            {
                "type":"custom_tool_call_output",
                "call_id":"call_patch",
                "output":"Success"
            }
        ]
    }))
    .unwrap();

    assert_eq!(
        provider_request["messages"][1]["content"][0],
        json!({
            "type":"tool_use",
            "id":"call_patch",
            "name":"apply_patch",
            "input":{"input": raw_patch}
        })
    );
}

#[test]
fn responses_custom_tool_projects_registered_anthropic_wrapper() {
    let raw_patch = "*** Begin Patch\n*** End Patch";
    let grammar = "start: patch\npatch: /[\\s\\S]+/";
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "tools":[{
            "type":"custom",
            "name":"apply_patch",
            "description":"Apply a patch",
            "format":{"type":"grammar","syntax":"lark","definition":grammar}
        }],
        "input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"patch"}]},
            {"type":"custom_tool_call","call_id":"call_patch","name":"apply_patch","input":raw_patch},
            {"type":"custom_tool_call_output","call_id":"call_patch","output":"done"}
        ]
    }))
    .expect("registered custom tool must project to Anthropic compatibility wrapper");

    let tool = &provider_request["tools"][0];
    assert_eq!(tool["name"], "apply_patch");
    assert_eq!(
        tool["input_schema"]["properties"]["input"]["type"],
        "string"
    );
    assert_eq!(tool["input_schema"]["required"], json!(["input"]));
    assert_eq!(tool["input_schema"]["additionalProperties"], false);
    let description = tool["description"].as_str().expect("tool description");
    assert!(description.contains("Apply a patch"), "{description}");
    assert!(
        description.contains("v3.custom_tool.anthropic_string_input_wrapper.v1"),
        "{description}"
    );
    assert!(description.contains("syntax=\"lark\""), "{description}");
    assert!(
        description.contains(&serde_json::to_string(grammar).unwrap()),
        "{description}"
    );
    assert!(
        description.contains("does not natively enforce"),
        "{description}"
    );
    assert_eq!(
        provider_request["messages"][1]["content"][0]["input"],
        json!({"input":raw_patch})
    );
}

#[test]
fn anthropic_registered_custom_wrapper_restores_exact_responses_raw_input() {
    let raw = "*** Begin Patch\n*** Update File: a.txt\n*** End Patch";
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
        "tools":[{
            "type":"custom",
            "name":"apply_patch",
            "format":{"type":"text"}
        }]
    }))
    .expect("governed custom declaration context");
    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id":"msg_custom",
            "role":"assistant",
            "content":[{
                "type":"tool_use",
                "id":"toolu_provider_generated",
                "name":"apply_patch",
                "input":{"input":raw}
            }],
            "stop_reason":"tool_use"
        }),
        &context,
    )
    .expect("registered wrapper must restore the custom call");

    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["call_id"], "toolu_provider_generated");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(response["output"][0]["input"], raw);
}

#[test]
fn anthropic_unregistered_input_wrapper_is_not_unwrapped_as_custom() {
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
        "tools":[{
            "type":"function",
            "name":"exec_command",
            "parameters":{"type":"object"}
        }]
    }))
    .expect("function declaration context");
    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id":"msg_function",
            "role":"assistant",
            "content":[{
                "type":"tool_use",
                "id":"toolu_function",
                "name":"exec_command",
                "input":{"input":"pwd"}
            }],
            "stop_reason":"tool_use"
        }),
        &context,
    )
    .expect("unregistered wrapper shape remains a function call");

    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["arguments"], "{\"input\":\"pwd\"}");
}

#[test]
fn anthropic_custom_wrapper_rejects_extra_or_non_string_input_without_repair() {
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
        "tools":[{
            "type":"custom",
            "name":"apply_patch",
            "format":{"type":"text"}
        }]
    }))
    .expect("custom declaration context");
    for malformed in [
        json!({"input":"raw","extra":true}),
        json!({"input":{"patch":"raw"}}),
    ] {
        let error = project_v3_anthropic_message_as_responses_response_with_context(
            &json!({
                "id":"msg_malformed_custom",
                "role":"assistant",
                "content":[{
                    "type":"tool_use",
                    "id":"toolu_malformed",
                    "name":"apply_patch",
                    "input":malformed
                }],
                "stop_reason":"tool_use"
            }),
            &context,
        )
        .expect_err("malformed registered wrapper must fail without repair");
        assert!(
            error.to_string().contains("custom tool_use.input"),
            "{error}"
        );
    }
}

#[test]
fn responses_custom_tool_call_missing_input_fails_without_empty_object_repair() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[
            {"type":"custom_tool_call","call_id":"call_missing","name":"apply_patch"},
            {"type":"custom_tool_call_output","call_id":"call_missing","output":"done"}
        ]
    }))
    .expect_err("custom tool input is required for the registered wrapper");
    assert!(format!("{error:?}").contains("custom_tool_call.input"));
}

#[test]
fn responses_custom_tool_call_non_string_input_fails_without_relabel_or_repair() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[
            {"type":"custom_tool_call","call_id":"call_object","name":"apply_patch","input":{"patch":"raw"}},
            {"type":"custom_tool_call_output","call_id":"call_object","output":"done"}
        ]
    }))
    .expect_err("custom wrapper accepts only the exact raw string input");
    assert!(format!("{error:?}").contains("custom_tool_call.input"));
}

#[test]
fn responses_valid_function_arguments_use_native_anthropic_object_input() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[
            {"type":"function_call","call_id":"call_valid","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"},
            {"type":"function_call_output","call_id":"call_valid","output":"/tmp"}
        ]
    }))
    .expect("valid function arguments use native object input");
    assert_eq!(
        provider_request["messages"][0]["content"][0]["input"],
        json!({"cmd":"pwd"})
    );
}

#[test]
fn responses_reasoning_summary_policy_is_local_hint_for_anthropic() {
    let wire = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": true,
        "reasoning_effort":"medium",
        "reasoning_summary_policy":"detailed",
        "messages":[{"role":"user","content":"keep reasoning enabled"}]
    }))
    .expect("valid reasoning summary policy is consumed as local response-shaping context");

    assert!(!serde_json::to_string(&wire)
        .unwrap()
        .contains("reasoning_summary_policy"));
    assert_eq!(wire["thinking"], json!({"type":"adaptive"}));
}

#[test]
fn responses_reasoning_summary_policy_enables_native_thinking_without_effort() {
    let wire = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "reasoning_summary_policy":"concise",
        "messages":[{"role":"user","content":"preserve thinking"}]
    }))
    .expect("summary policy must statically enable native Anthropic thinking");

    assert_eq!(wire["thinking"], json!({"type":"adaptive"}));
    assert!(!serde_json::to_string(&wire)
        .unwrap()
        .contains("reasoning_summary_policy"));
}

#[test]
fn anthropic_projection_context_consumes_reasoning_summary_policy_for_response_shape() {
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
        "reasoning_summary_policy":"concise",
        "messages":[{"role":"user","content":"shape reasoning"}]
    }))
    .expect("valid summary policy must enter response projection context");
    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id":"msg_reasoning_policy",
            "role":"assistant",
            "model":"claude-fable-5",
            "content":[{
                "type":"thinking",
                "thinking":"First concise line\nSecond detailed line",
                "signature":"sig_reasoning_policy"
            }],
            "stop_reason":"end_turn"
        }),
        &context,
    )
    .expect("Anthropic response projection must consume the local summary policy");

    assert_eq!(
        response["output"][0]["summary"][0]["text"],
        "First concise line\nSecond detailed line"
    );
    assert!(
        !serde_json::to_string(&response)
            .unwrap()
            .contains("reasoning_summary_policy"),
        "local policy must not leak into client payload: {response}"
    );
}

#[test]
fn responses_claude_provider_request_replaces_system_with_claude_code_prompt_blocks() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"claude-fable-5",
        "stream": true,
        "instructions":"replace this transient instruction",
        "input":[
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"reply ok"}]
            }
        ]
    }))
    .expect("Claude model Anthropic wire must inject the Claude Code prompt");

    let system = provider_request["system"]
        .as_array()
        .expect("Claude Code prompt must use Anthropic system content blocks");
    assert_eq!(system.len(), 3);
    assert_eq!(
        system[0]["text"],
        "x-anthropic-billing-header: cc_version=2.1.220.dae; cc_entrypoint=sdk-cli;"
    );
    assert_eq!(
        system[1]["text"],
        "You are a Claude agent, built on Anthropic's Claude Agent SDK."
    );
    assert_eq!(system[1]["cache_control"], json!({"type":"ephemeral"}));
    assert_eq!(system[2]["cache_control"], json!({"type":"ephemeral"}));
    assert!(
        system[2]["text"].as_str().is_some_and(|text| text.contains(
            "You are an interactive agent that helps users with software engineering tasks."
        )),
        "full Claude Code prompt block must be present: {provider_request}"
    );
    assert!(system[2]["text"]
        .as_str()
        .is_some_and(|text| text.contains("/tmp/claude-code-standard-capture-1785077403/work")));
    assert!(!system[2]["text"]
        .as_str()
        .is_some_and(|text| text.contains("claude-code-capture.kJhuye")));
    assert_eq!(provider_request["messages"][0]["role"], "user");
    assert_eq!(
        provider_request["messages"][0]["content"][0]["text"],
        "reply ok"
    );
    let serialized = serde_json::to_string(&provider_request).unwrap();
    assert!(
        !serialized.contains("replace this transient instruction"),
        "Claude Code prompt is a replacement, not a merge: {provider_request}"
    );
}

#[test]
fn anthropic_entry_dynamic_claude_code_request_survives_anthropic_provider_roundtrip() {
    let dynamic_system = json!([
        {
            "type":"text",
            "text":"x-anthropic-billing-header: cc_version=2.1.220.297; cc_entrypoint=sdk-cli;"
        },
        {
            "type":"text",
            "text":"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
            "cache_control":{"type":"ephemeral"}
        },
        {
            "type":"text",
            "text":"DYNAMIC_CLAUDE_CODE_SYSTEM_BLOCK_3",
            "cache_control":{"type":"ephemeral"}
        }
    ]);
    let context_management = json!({
        "edits":[{"type":"clear_thinking_20251015","keep":"all"}]
    });
    let output_config = json!({"effort":"high"});
    let thinking = json!({"type":"adaptive","display":"omitted"});
    let semantic = encode_v3_anthropic_request_as_responses_semantic(json!({
        "model":"claude-fable-5",
        "max_tokens":32,
        "stream":true,
        "system":dynamic_system,
        "messages":[{
            "role":"user",
            "content":[{"type":"text","text":"Reply with exactly: ok"}]
        }],
        "metadata":{
            "user_id":"{\"device_id\":\"test-device\",\"account_uuid\":\"\",\"session_id\":\"test-session\"}"
        },
        "thinking":thinking,
        "context_management":context_management,
        "output_config":output_config,
        "tools":[]
    }))
    .expect("Anthropic entry packet must normalize to Chat semantic");
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(semantic)
        .expect("Anthropic semantic must project back to Anthropic provider wire");

    assert_eq!(provider_request["system"], dynamic_system);
    assert_eq!(provider_request["thinking"], thinking);
    assert_eq!(provider_request["context_management"], context_management);
    assert_eq!(provider_request["output_config"], output_config);
    assert_eq!(provider_request["max_tokens"], 32);
    assert_eq!(provider_request["stream"], true);
    assert_eq!(
        provider_request["messages"],
        json!([{"role":"user","content":[{"type":"text","text":"Reply with exactly: ok"}]}])
    );
    let serialized = serde_json::to_string(&provider_request).unwrap();
    assert!(
        !serialized.contains("cc_version=2.1.220.dae"),
        "Anthropic entry relay must not overwrite dynamic Claude Code system with static compat prompt: {provider_request}"
    );
}

#[test]
fn responses_reasoning_embedded_thinking_config_preserves_exact_anthropic_shape() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "reasoning_effort":"high",
        "reasoning_thinking_mode":"enabled",
        "reasoning_budget_tokens":8192,
        "messages":[{"role":"user","content":"preserve Anthropic-compatible thinking"}]
    }))
    .expect("Chat thinking fields must stay lossless for Anthropic wire");

    assert_eq!(
        provider_request["thinking"],
        json!({"type":"enabled","budget_tokens":8192})
    );
    assert!(
        provider_request.get("reasoning").is_none(),
        "Anthropic provider wire must not carry Responses reasoning config: {provider_request}"
    );
}

#[test]
fn anthropic_assistant_thinking_history_normalizes_to_ordered_responses_reasoning() {
    let semantic = encode_v3_anthropic_request_as_responses_semantic(json!({
        "model":"claude-sonnet",
        "messages":[{
            "role":"assistant",
            "content":[
                {"type":"thinking","thinking":"inspect cwd","signature":"sig-anthropic-1"},
                {"type":"text","text":"calling pwd"},
                {"type":"redacted_thinking","data":"redacted-anthropic-2"},
                {"type":"tool_use","id":"call_pwd","name":"exec_command","input":{"cmd":"pwd"}}
            ]
        }]
    }))
    .expect("Anthropic thinking history must normalize into the Responses pipeline");

    assert_eq!(
        semantic["input"],
        json!([
            {
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":"inspect cwd"}],
                "encrypted_content":"sig-anthropic-1"
            },
            {
                "role":"assistant",
                "content":[{"type":"input_text","text":"calling pwd"}]
            },
            {
                "type":"reasoning",
                "encrypted_content":"redacted-anthropic-2"
            },
            {
                "type":"function_call",
                "call_id":"call_pwd",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            }
        ])
    );
}

#[test]
fn anthropic_malformed_thinking_history_fails_instead_of_disappearing() {
    let error = encode_v3_anthropic_request_as_responses_semantic(json!({
        "model":"claude-sonnet",
        "messages":[{
            "role":"assistant",
            "content":[{"type":"thinking","thinking":"","signature":"sig-without-thinking"}]
        }]
    }))
    .expect_err("malformed Anthropic thinking must fail before entering Hub semantics");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "reasoning content"
        }
    ));
}

#[test]
fn anthropic_thinking_history_rejects_cross_type_alias_fields() {
    for content in [
        json!({"type":"thinking","text":"alias text","data":"alias signature"}),
        json!({"type":"redacted_thinking","signature":"alias redacted payload"}),
        json!({"type":"reasoning","reasoning":"non-Anthropic alias"}),
    ] {
        let error = encode_v3_anthropic_request_as_responses_semantic(json!({
            "model":"claude-sonnet",
            "messages":[{"role":"assistant","content":[content]}]
        }))
        .expect_err("Anthropic history must reject cross-type reasoning aliases");

        assert!(matches!(
            error,
            V3AnthropicCodecError::MalformedField {
                field: "reasoning content"
            }
        ));
    }
}

#[test]
fn anthropic_thinking_history_rejects_native_and_alias_dual_truth() {
    for content in [
        json!({
            "type":"thinking",
            "thinking":"native thinking",
            "text":"alias thinking"
        }),
        json!({
            "type":"redacted_thinking",
            "data":"native encrypted content",
            "signature":"alias encrypted content"
        }),
    ] {
        let error = encode_v3_anthropic_request_as_responses_semantic(json!({
            "model":"claude-sonnet",
            "messages":[{"role":"assistant","content":[content]}]
        }))
        .expect_err("Anthropic history must reject native and alias dual truth");

        assert!(matches!(
            error,
            V3AnthropicCodecError::MalformedField {
                field: "reasoning content"
            }
        ));
    }
}

#[test]
fn responses_replay_reasoning_restores_anthropic_thinking_and_redacted_blocks() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"inspect the cwd"}]
            },
            {
                "type":"reasoning",
                "content": null,
                "summary":[{"type":"summary_text","text":"Need to inspect cwd first."}],
                "encrypted_content":"opaque-openai-reasoning"
            },
            {
                "type":"reasoning",
                "summary":[],
                "encrypted_content":"opaque-redacted-reasoning"
            },
            {
                "type":"function_call",
                "call_id":"call_pwd",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"function_call_output",
                "call_id":"call_pwd",
                "output":"/tmp"
            }
        ]
    }))
    .expect("Responses replay-safe reasoning must restore Anthropic thinking history");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic request messages");
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"][0]["type"], "thinking");
    assert_eq!(
        messages[1]["content"][0]["thinking"],
        "Need to inspect cwd first."
    );
    assert_eq!(
        messages[1]["content"][0]["signature"],
        "opaque-openai-reasoning"
    );
    assert_eq!(messages[2]["role"], "assistant");
    assert_eq!(messages[2]["content"][0]["type"], "redacted_thinking");
    assert_eq!(
        messages[2]["content"][0]["data"],
        "opaque-redacted-reasoning"
    );
    assert_eq!(messages[3]["role"], "assistant");
    assert_eq!(messages[3]["content"][0]["type"], "tool_use");
    assert_eq!(messages[4]["role"], "user");
    assert_eq!(messages[4]["content"][0]["type"], "tool_result");
}

#[test]
fn responses_reasoning_rejects_content_and_summary_dual_truth() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream":false,
        "input":[{
            "type":"reasoning",
            "content":[{"type":"reasoning_text","text":"private content"}],
            "summary":[{"type":"summary_text","text":"public summary"}]
        }]
    }))
    .expect_err("Anthropic wire cannot preserve both Responses reasoning content and summary");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "reasoning item"
        }
    ));
}

#[test]
fn responses_reasoning_null_encrypted_content_is_absent_identity() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream":false,
        "input":[{
            "type":"reasoning",
            "summary":[{"type":"summary_text","text":"visible thought"}],
            "encrypted_content":null
        }]
    }))
    .expect("Responses reasoning encrypted_content:null is equivalent to absent identity");

    assert_eq!(provider_request["messages"][0]["role"], "assistant");
    assert_eq!(
        provider_request["messages"][0]["content"][0]["type"],
        "thinking"
    );
    assert_eq!(
        provider_request["messages"][0]["content"][0]["thinking"],
        "visible thought"
    );
    assert!(
        provider_request["messages"][0]["content"][0]
            .get("signature")
            .is_none(),
        "null encrypted_content must not become an Anthropic signature"
    );
}

#[test]
fn responses_reasoning_rejects_malformed_encrypted_content() {
    for encrypted_content in [json!(42), json!({}), json!("")] {
        let error = encode_v3_responses_semantic_as_anthropic_request(json!({
            "model":"MiniMax-M3",
            "stream":false,
            "input":[{
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":"visible thought"}],
                "encrypted_content":encrypted_content
            }]
        }))
        .expect_err("malformed encrypted_content must not disappear from Anthropic wire");

        assert!(matches!(
            error,
            V3AnthropicCodecError::MalformedField {
                field: "reasoning item"
            }
        ));
    }
}

#[test]
fn responses_developer_messages_project_to_anthropic_system_not_message_role() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "instructions":"top instruction",
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"hello"}]
            },
            {
                "type":"message",
                "role":"developer",
                "content":[
                    {"type":"input_text","text":"developer rule one"},
                    {"type":"input_text","text":"developer rule two"}
                ]
            },
            {
                "type":"message",
                "role":"system",
                "content":[{"type":"input_text","text":"system replay rule"}]
            },
            {
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"ok"}]
            }
        ]
    }))
    .expect("Responses developer/system instruction items must be valid Anthropic wire");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic request messages");
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    assert!(messages
        .iter()
        .all(|message| matches!(message["role"].as_str(), Some("user" | "assistant"))));
    let system = provider_request["system"]
        .as_str()
        .expect("Anthropic top-level system");
    assert!(system.contains("top instruction"));
    assert!(system.contains("developer rule one"));
    assert!(system.contains("developer rule two"));
    assert!(system.contains("system replay rule"));
}

#[test]
fn responses_builtin_tool_types_encode_with_anthropic_native_web_search_and_object_tool_choice() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "tool_choice": "auto",
        "input": "Use search if needed.",
        "tools": [
            {
                "type":"tool_search",
                "description":"Discover deferred tools.",
                "parameters":{
                    "type":"object",
                    "properties":{"query":{"type":"string"}},
                    "required":["query"]
                }
            },
            {
                "type":"web_search_preview",
                "filters":{"allowed_domains":["example.com"]},
                "user_location":{
                    "type":"approximate",
                    "city":"San Francisco",
                    "country":"US",
                    "region":"California",
                    "timezone":"America/Los_Angeles"
                },
                "search_context_size":"high"
            }
        ]
    }))
    .expect("Responses builtin tools must encode as valid Anthropic tools");

    assert_eq!(provider_request["tool_choice"], json!({"type":"auto"}));
    let tools = provider_request["tools"]
        .as_array()
        .expect("Anthropic tools array");
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["name"], json!("tool_search"));
    assert_eq!(tools[0]["description"], json!("Discover deferred tools."));
    assert_eq!(tools[0]["input_schema"]["required"], json!(["query"]));
    assert!(tools[0].get("type").is_none());
    assert!(tools[0].get("parameters").is_none());
    assert_eq!(tools[1]["type"], json!("web_search_20250305"));
    assert_eq!(tools[1]["name"], json!("web_search"));
    assert_eq!(tools[1]["allowed_domains"], json!(["example.com"]));
    assert_eq!(tools[1]["user_location"]["country"], json!("US"));
    assert!(tools[1].get("input_schema").is_none());
    assert!(tools[1].get("search_context_size").is_none());

    let required_choice = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "tool_choice": "required",
        "input": "Use a tool or reasoningStop.",
        "tools": [{"type":"function","name":"reasoningStop","parameters":{"type":"object","properties":{"stopreason":{"type":"integer"}},"required":["stopreason"]}}]
    }))
    .expect("Responses required tool_choice must encode as Anthropic any");
    assert_eq!(required_choice["tool_choice"], json!({"type":"any"}));
}

#[test]
fn responses_object_tool_choice_preserves_anthropic_disable_parallel_without_top_level_leak() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "tool_choice": {
            "type":"function",
            "name":"lookup",
            "disable_parallel_tool_use": true
        },
        "parallel_tool_calls": false,
        "input": "Lookup once.",
        "tools": [{
            "type":"function",
            "name":"lookup",
            "parameters":{"type":"object","properties":{"q":{"type":"string"}}}
        }]
    }))
    .expect("Responses tool_choice object must project to Anthropic tool_choice");

    assert_eq!(
        provider_request["tool_choice"],
        json!({"type":"tool","name":"lookup","disable_parallel_tool_use":true})
    );
    assert!(
        provider_request.get("parallel_tool_calls").is_none(),
        "Anthropic provider wire must not receive non-spec top-level parallel_tool_calls: {provider_request}"
    );
}

#[test]
fn responses_named_custom_tool_choice_projects_registered_anthropic_tool_choice() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "tool_choice": {"type":"custom","name":"shell_raw"},
        "input": "Call the custom tool.",
        "tools": [{
            "type":"custom",
            "name":"shell_raw",
            "description":"Execute raw input.",
            "format":{"type":"text"}
        }]
    }))
    .expect("named custom choice must use the registered Anthropic tool declaration");

    assert_eq!(
        provider_request["tool_choice"],
        json!({"type":"tool","name":"shell_raw"})
    );
    assert_eq!(provider_request["tools"][0]["name"], json!("shell_raw"));
    assert_eq!(
        provider_request["tools"][0]["input_schema"]["properties"]["input"]["type"],
        json!("string")
    );
}

#[test]
fn responses_named_custom_tool_choice_without_name_fails() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "tool_choice": {"type":"custom"},
        "input": "Call the custom tool.",
        "tools": [{
            "type":"custom",
            "name":"shell_raw",
            "format":{"type":"text"}
        }]
    }))
    .expect_err("custom choice without an exact name must fail");

    assert_eq!(
        error.to_string(),
        "Anthropic codec malformed tool_choice.name"
    );
}

#[test]
fn responses_additional_tools_input_item_projects_to_anthropic_tool_surface() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": true,
        "tool_choice": "required",
        "instructions":"Continue current goal; use tools before reporting done.",
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"继续执行"}]
            },
            {
                "type":"additional_tools",
                "tools":[
                    {
                        "type":"function",
                        "name":"exec",
                        "description":"Run a command",
                        "parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}
                    },
                    {
                        "type":"function",
                        "name":"wait",
                        "parameters":{"type":"object","properties":{"ms":{"type":"integer"}}}
                    },
                    {
                        "type":"function",
                        "name":"request_user_input",
                        "parameters":{"type":"object","properties":{"question":{"type":"string"}}}
                    },
                    {
                        "type":"function",
                        "name":"reasoningStop",
                        "description":"0=完成 1=阻塞 2=继续 evidence reason",
                        "parameters":{"type":"object","properties":{"stopreason":{"type":"integer"}},"required":["stopreason"]}
                    }
                ]
            }
        ]
    }))
    .expect("Responses additional_tools item must become Anthropic top-level tools");

    assert_eq!(provider_request["tool_choice"], json!({"type":"any"}));
    let tools = provider_request["tools"]
        .as_array()
        .expect("Anthropic provider request must expose tools top-level");
    let names = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("Anthropic tool name"))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec!["exec", "wait", "request_user_input", "reasoningStop"],
        "Anthropic provider wire dropped restored Responses additional_tools: {provider_request}"
    );
    assert_eq!(tools[0]["input_schema"]["required"], json!(["cmd"]));
    assert_eq!(
        tools[3]["description"],
        json!("0=完成 1=阻塞 2=继续 evidence reason")
    );
}

#[test]
fn responses_unknown_nameless_tool_fails_before_provider_wire() {
    let err = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": "hi",
        "tools": [{"type":"deferred_unknown","parameters":{"type":"object"}}]
    }))
    .expect_err("unknown nameless tools must not produce Anthropic tools[].name = null");

    assert!(matches!(
        err,
        V3AnthropicCodecError::MalformedField {
            field: "tools[].name"
        }
    ));
}

#[test]
fn responses_consecutive_tool_calls_group_before_results_for_anthropic_order() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"inspect files"}]
            },
            {
                "type":"reasoning",
                "content": null,
                "encrypted_content":"opaque"
            },
            {
                "type":"function_call",
                "call_id":"call_one",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"custom_tool_call",
                "call_id":"call_two",
                "name":"apply_patch",
                "input":"*** Begin Patch\n*** End Patch\n"
            },
            {
                "type":"function_call_output",
                "call_id":"call_one",
                "output":"/tmp"
            },
            {
                "type":"custom_tool_call_output",
                "call_id":"call_two",
                "output":"Success"
            }
        ]
    }))
    .expect("consecutive Responses tool calls/results must become Anthropic-adjacent blocks");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic request messages");
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[1]["role"], json!("assistant"));
    assert_eq!(
        messages[1]["content"][0],
        json!({"type":"redacted_thinking","data":"opaque"})
    );
    assert_eq!(messages[2]["role"], json!("assistant"));
    assert_eq!(messages[2]["content"][0]["type"], json!("tool_use"));
    assert_eq!(messages[2]["content"][0]["id"], json!("call_one"));
    assert_eq!(messages[2]["content"][1]["type"], json!("tool_use"));
    assert_eq!(messages[2]["content"][1]["id"], json!("call_two"));
    assert_eq!(messages[3]["role"], json!("user"));
    assert_eq!(messages[3]["content"][0]["type"], json!("tool_result"));
    assert_eq!(messages[3]["content"][0]["tool_use_id"], json!("call_one"));
    assert_eq!(messages[3]["content"][1]["type"], json!("tool_result"));
    assert_eq!(messages[3]["content"][1]["tool_use_id"], json!("call_two"));
}

#[test]
fn responses_malformed_function_call_arguments_keep_pair_with_reversible_anthropic_input() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": true,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"continue the task"}]
            },
            {
                "type":"function_call",
                "call_id":"call_unpaired_bad_args",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"
            },
            {
                "type":"function_call_output",
                "call_id":"call_unpaired_bad_args",
                "output":"failed to parse function arguments"
            }
        ]
    }))
    .expect("malformed historical Responses arguments must keep the feedback pair");
    assert_eq!(
        provider_request["messages"][1]["content"][0]["type"],
        json!("tool_use")
    );
    assert_eq!(
        provider_request["messages"][1]["content"][0]["id"],
        json!("call_unpaired_bad_args")
    );
    assert_eq!(
        provider_request["messages"][1]["content"][0]["input"],
        json!({"input":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"})
    );
    assert_eq!(
        provider_request["messages"][2]["content"][0]["type"],
        json!("tool_result")
    );
    assert_eq!(
        provider_request["messages"][2]["content"][0]["tool_use_id"],
        json!("call_unpaired_bad_args")
    );
}

#[test]
fn chat_malformed_tool_call_arguments_keep_pair_with_reversible_anthropic_input() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "messages":[
            {"role":"user","content":"continue the task"},
            {"role":"assistant","content":"","tool_calls":[{
                "id":"call_malformed_chat",
                "type":"function",
                "function":{
                    "name":"exec_command",
                    "arguments":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"
                }
            }]},
            {"role":"tool","tool_call_id":"call_malformed_chat","content":"failed to parse function arguments"}
        ]
    }))
    .expect("malformed historical Chat arguments must keep the feedback pair");
    assert_eq!(
        provider_request["messages"][1]["content"][1]["type"],
        json!("tool_use")
    );
    assert_eq!(
        provider_request["messages"][1]["content"][1]["id"],
        json!("call_malformed_chat")
    );
    assert_eq!(
        provider_request["messages"][1]["content"][1]["input"],
        json!({"input":"{\"cmd\":\"one\"}{\"cmd\":\"two\"}"})
    );
    assert_eq!(
        provider_request["messages"][2]["content"][0]["type"],
        json!("tool_result")
    );
    assert_eq!(
        provider_request["messages"][2]["content"][0]["tool_use_id"],
        json!("call_malformed_chat")
    );
}

#[test]
fn responses_tool_output_without_immediate_call_group_fails_before_provider_wire() {
    let err = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"function_call",
                "call_id":"call_one",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"break the tool adjacency"}]
            },
            {
                "type":"function_call_output",
                "call_id":"call_one",
                "output":"/tmp"
            }
        ]
    }))
    .expect_err("tool outputs must directly follow their Responses call group");

    assert!(matches!(
        err,
        V3AnthropicCodecError::MalformedField {
            field: "function_call_output"
        }
    ));
}

#[test]
fn responses_assistant_text_between_tool_call_and_output_preserves_anthropic_adjacency() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"push and check health"}]
            },
            {
                "type":"function_call",
                "call_id":"call_push",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"git push origin main\"}"
            },
            {
                "type":"function_call",
                "call_id":"call_health",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"curl -fsS https://example.test/health\"}"
            },
            {
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"I will push first, then verify health."}]
            },
            {
                "type":"function_call_output",
                "call_id":"call_push",
                "output":"main -> main"
            },
            {
                "type":"function_call_output",
                "call_id":"call_health",
                "output":"{\"ok\":true}"
            }
        ]
    }))
    .expect("assistant text between Responses calls and outputs must not break Anthropic tool_result adjacency");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], json!("assistant"));
    let assistant_content = messages[1]["content"]
        .as_array()
        .expect("assistant content");
    assert_eq!(assistant_content[0]["type"], json!("tool_use"));
    assert_eq!(assistant_content[0]["id"], json!("call_push"));
    assert_eq!(assistant_content[1]["type"], json!("tool_use"));
    assert_eq!(assistant_content[1]["id"], json!("call_health"));
    assert_eq!(assistant_content[2]["type"], json!("text"));
    assert_eq!(
        assistant_content[2]["text"],
        json!("I will push first, then verify health.")
    );
    assert_eq!(messages[2]["role"], json!("user"));
    assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
    assert_eq!(messages[2]["content"][0]["tool_use_id"], json!("call_push"));
    assert_eq!(messages[2]["content"][1]["type"], json!("tool_result"));
    assert_eq!(
        messages[2]["content"][1]["tool_use_id"],
        json!("call_health")
    );
}

#[test]
fn responses_hosted_web_search_between_tool_call_and_output_preserves_anthropic_adjacency() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "stream": false,
        "input": [
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"search, then run the command"}]
            },
            {
                "type":"function_call",
                "call_id":"call_exec",
                "name":"exec_command",
                "arguments":"{\"cmd\":\"pwd\"}"
            },
            {
                "type":"web_search_call",
                "id":"ws_search_2",
                "status":"completed",
                "action":{
                    "type":"search",
                    "query":"Ubuntu 24.04 Snapdragon X Elite"
                },
                "result":{"title":"Ubuntu ARM64","url":"https://example.test"}
            },
            {
                "type":"function_call_output",
                "call_id":"call_exec",
                "output":"/tmp"
            }
        ]
    }))
    .expect("hosted web-search history must preserve the surrounding Anthropic tool pair");

    let messages = provider_request["messages"]
        .as_array()
        .expect("Anthropic messages");
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1]["role"], json!("assistant"));
    assert_eq!(messages[1]["content"][0]["type"], json!("tool_use"));
    assert_eq!(messages[1]["content"][0]["id"], json!("call_exec"));
    assert_eq!(messages[1]["content"][1]["type"], json!("server_tool_use"));
    assert_eq!(messages[1]["content"][1]["id"], json!("ws_search_2"));
    assert_eq!(
        messages[1]["content"][2]["type"],
        json!("web_search_tool_result")
    );
    assert_eq!(
        messages[1]["content"][2]["tool_use_id"],
        json!("ws_search_2")
    );
    assert_eq!(messages[2]["role"], json!("user"));
    assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
    assert_eq!(messages[2]["content"][0]["tool_use_id"], json!("call_exec"));
}

#[test]
fn responses_hosted_web_search_without_identity_gets_deterministic_anthropic_wire_id() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "status":"completed",
            "action":{"type":"search","queries":["Ubuntu ARM64"],"query":""}
        }]
    }))
    .expect("hosted web-search history may omit transport identity and outcome payload");

    assert_eq!(
        provider_request["messages"][0]["content"][0]["id"],
        json!("call_routecodex_web_search_0")
    );
    assert_eq!(
        provider_request["messages"][0]["content"][1]["tool_use_id"],
        json!("call_routecodex_web_search_0")
    );
    assert_eq!(
        provider_request["messages"][0]["content"][1]["content"]["status"],
        json!("completed")
    );
    assert_eq!(
        provider_request["messages"][0]["content"][1]["content"]["action"]["queries"][0],
        json!("Ubuntu ARM64")
    );
}

#[test]
fn responses_hosted_web_search_conflicting_identity_aliases_fail_before_anthropic_wire() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_id",
            "call_id":"ws_search_call",
            "status":"completed",
            "action":{"type":"search","query":"Ubuntu ARM64"}
        }]
    }))
    .expect_err("hosted web-search conflicting transport identity aliases are ambiguous");
    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.id"
        }
    ));
}

#[test]
fn responses_hosted_web_search_action_side_channel_fails_before_anthropic_wire() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"completed",
            "action":{
                "type":"search",
                "query":"Ubuntu ARM64",
                "metadata_center":{"leak":true}
            },
            "result":{"title":"Ubuntu ARM64"}
        }]
    }))
    .expect_err("nested RouteCodex side-channel must not reach Anthropic provider wire");

    assert!(matches!(
        error,
        V3AnthropicCodecError::SideChannelLeaked {
            field: "metadata_center"
        }
    ));
}

#[test]
fn responses_hosted_web_search_with_malformed_action_fails_before_anthropic_wire() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "status":"completed",
            "action":"not-an-object"
        }]
    }))
    .expect_err("malformed hosted web-search history must not be silently dropped");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.action"
        }
    ));
}

#[test]
fn responses_hosted_web_search_with_empty_action_fails_before_anthropic_wire() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"completed",
            "action":{}
        }]
    }))
    .expect_err("hosted web-search action must include a supported discriminator");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.action.type"
        }
    ));
}

#[test]
fn responses_hosted_web_search_with_result_preserves_outcome() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"completed",
            "action":{
                "type":"search",
                "query":"Ubuntu ARM64"
            },
            "result":{
                "title":"Ubuntu ARM64",
                "url":"https://example.test"
            }
        }]
    }))
    .expect("hosted web-search result-bearing history must preserve outcome");

    let result_content = &provider_request["messages"][0]["content"][1]["content"];
    assert_eq!(result_content["status"], json!("completed"));
    assert_eq!(result_content["result"]["title"], json!("Ubuntu ARM64"));
    assert_eq!(
        provider_request["messages"][0]["content"][0]["input"]["query"],
        json!("Ubuntu ARM64")
    );
}

#[test]
fn responses_failed_hosted_web_search_without_error_preserves_terminal_status() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"failed",
            "action":{
                "type":"search",
                "query":"Ubuntu ARM64"
            }
        }]
    }))
    .expect("failed hosted web-search may be status-only history");

    let result_content = &provider_request["messages"][0]["content"][1]["content"];
    assert_eq!(result_content["status"], json!("failed"));
    assert_eq!(result_content["action"]["query"], json!("Ubuntu ARM64"));
    assert!(result_content.get("error").is_none());
}

#[test]
fn responses_failed_hosted_web_search_with_error_preserves_terminal_failure() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"failed",
            "action":{
                "type":"search",
                "query":"Ubuntu ARM64"
            },
            "error":{"code":"provider_error","message":"search failed"}
        }]
    }))
    .expect("terminal failed hosted web-search with error must preserve failure outcome");

    let result_content = &provider_request["messages"][0]["content"][1]["content"];
    assert_eq!(result_content["status"], json!("failed"));
    assert_eq!(result_content["error"]["code"], json!("provider_error"));
}

#[test]
fn responses_nonterminal_hosted_web_search_fails_before_anthropic_wire() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"in_progress",
            "action":{
                "type":"search",
                "query":"Ubuntu ARM64"
            },
            "result":{"title":"not terminal"}
        }]
    }))
    .expect_err("nonterminal hosted web-search must not be projected as a completed result");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.status"
        }
    ));
}

#[test]
fn responses_unknown_hosted_web_search_status_fails_before_anthropic_wire() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"already_terminal",
            "action":{
                "type":"search",
                "query":"Ubuntu ARM64"
            },
            "result":{"title":"ambiguous"}
        }]
    }))
    .expect_err("unknown hosted web-search status must fail before provider send");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.status"
        }
    ));
}

#[test]
fn responses_completed_hosted_web_search_with_error_fails_before_anthropic_wire() {
    let error = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "input":[{
            "type":"web_search_call",
            "id":"ws_search_2",
            "status":"completed",
            "action":{
                "type":"search",
                "query":"Ubuntu ARM64"
            },
            "error":{"code":"unexpected"}
        }]
    }))
    .expect_err("completed hosted web-search with error has contradictory terminal outcome");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "web_search_call.result"
        }
    ));
}

#[test]
fn response_characterization_preserves_anthropic_json_tool_use_reasoning_and_client_projection() {
    let raw = json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "stop_reason": "tool_use",
        "content": [
            {"type":"thinking","thinking":"short trace"},
            {"type":"text","text":"calling tool"},
            {"type":"tool_use","id":"toolu_2","name":"lookup","input":{"q":"y"}}
        ]
    });
    let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
        raw.clone(),
        V3HubProviderWireProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    assert_eq!(semantic.payload(), &raw);
    assert_eq!(
        semantic.trace().transport_intent,
        V3HubTransportIntent::Json
    );
    assert_eq!(
        semantic.trace().stage,
        V3AnthropicCodecStage::ProviderRawToHubResponseSemantic
    );

    let client =
        characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(client.payload(), &raw);
    assert_eq!(
        client.trace().stage,
        V3AnthropicCodecStage::HubResponseSemanticToClientProjection
    );
}

#[test]
fn response_characterization_preserves_anthropic_redacted_reasoning_as_encrypted_content() {
    let response = project_v3_anthropic_message_as_responses_response(&json!({
        "id":"msg_redacted_reasoning",
        "type":"message",
        "role":"assistant",
        "content":[
            {"type":"redacted_thinking","data":"redacted-sig-1"},
            {"type":"thinking","thinking":"visible thought","signature":"thinking-sig-1"},
            {"type":"text","text":"visible answer"}
        ],
        "stop_reason":"end_turn"
    }))
    .expect(
        "Anthropic redacted/thinking signatures must project to replay-safe Responses reasoning",
    );

    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(response["output"][0]["encrypted_content"], "redacted-sig-1");
    assert!(response["output"][0].get("summary").is_none());
    assert_eq!(response["output"][1]["type"], "reasoning");
    assert_eq!(
        response["output"][1]["summary"][0]["text"],
        "visible thought"
    );
    assert_eq!(response["output"][1]["encrypted_content"], "thinking-sig-1");
    assert_eq!(
        response["output"][2]["content"][0]["text"],
        "visible answer"
    );
    assert!(!response.to_string().contains("redacted_thinking"));
}

#[test]
fn responses_reasoning_encrypted_content_projects_to_anthropic_thinking_identity() {
    let projected = routecodex_v3_runtime::project_v3_responses_json_as_anthropic_message(&json!({
        "id":"resp_reasoning_identity",
        "status":"completed",
        "output":[
            {
                "type":"reasoning",
                "summary":[{"type":"summary_text","text":"visible thought"}],
                "encrypted_content":"thinking-signature"
            },
            {
                "type":"reasoning",
                "summary":[],
                "encrypted_content":"redacted-payload"
            }
        ]
    }))
    .expect("Responses reasoning identity must project to Anthropic client blocks");

    assert_eq!(
        projected["content"],
        json!([
            {
                "type":"thinking",
                "thinking":"visible thought",
                "signature":"thinking-signature"
            },
            {
                "type":"redacted_thinking",
                "data":"redacted-payload"
            }
        ])
    );
}

#[test]
fn responses_client_projection_rejects_malformed_reasoning_encrypted_content() {
    let error = routecodex_v3_runtime::project_v3_responses_json_as_anthropic_message(&json!({
        "id":"resp_malformed_reasoning_identity",
        "status":"completed",
        "output":[{
            "type":"reasoning",
            "summary":[{"type":"summary_text","text":"visible thought"}],
            "encrypted_content":{"unexpected":"object"}
        }]
    }))
    .expect_err("malformed encrypted_content must fail before Anthropic client projection");

    assert!(matches!(
        error,
        V3AnthropicCodecError::MalformedField {
            field: "reasoning item"
        }
    ));
}

#[test]
fn sse_characterization_preserves_individual_reasoning_and_tool_events_without_materialization() {
    let events = [
        json!({
            "type":"content_block_start",
            "index":0,
            "content_block":{"type":"thinking","thinking":""}
        }),
        json!({
            "type":"content_block_delta",
            "index":0,
            "delta":{"type":"thinking_delta","thinking":"trace"}
        }),
        json!({
            "type":"content_block_start",
            "index":1,
            "content_block":{"type":"tool_use","id":"toolu_sse","name":"lookup","input":{}}
        }),
        json!({
            "type":"content_block_delta",
            "index":1,
            "delta":{"type":"input_json_delta","partial_json":r#"{"q":"z"}"#}
        }),
        json!({"type":"message_stop"}),
    ];
    for event in events {
        let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            event.clone(),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Sse,
        )
        .unwrap();
        assert_eq!(semantic.payload(), &event);
        assert_eq!(semantic.trace().transport_intent, V3HubTransportIntent::Sse);
        let client =
            characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
        assert_eq!(client.payload(), &event);
    }
}

#[test]
fn provider_error_characterization_is_explicit_and_protocol_bound() {
    let error = json!({
        "type": "error",
        "error": {"type": "invalid_request_error", "message": "bad tool result"}
    });
    let semantic = characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
        error.clone(),
        V3HubProviderWireProtocol::Anthropic,
        V3HubTransportIntent::Json,
    )
    .unwrap();
    let client =
        characterize_v3_anthropic_hub_response_semantic_to_client_projection(semantic).unwrap();
    assert_eq!(client.payload(), &error);

    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            json!({"error":{"type":"invalid_request_error"}}),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::MalformedProviderError)
    ));
    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            error,
            V3HubProviderWireProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::ProviderProtocolNotAnthropic)
    ));
    assert!(matches!(
        characterize_v3_anthropic_provider_raw_to_hub_response_semantic(
            json!({"type":"invented_event"}),
            V3HubProviderWireProtocol::Anthropic,
            V3HubTransportIntent::Sse,
        ),
        Err(V3AnthropicCodecError::MalformedSseEvent)
    ));
}

#[test]
fn nested_business_fields_named_like_side_channels_are_preserved() {
    let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
        "model":"MiniMax-M3",
        "tools":[{
            "type":"function",
            "name":"echo_schema",
            "parameters":{
                "type":"object",
                "properties":{"provider_protocol":{"type":"string"}}
            }
        }],
        "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]
    }))
    .expect("business schema fields are not RouteCodex side-channel carriers");

    assert_eq!(
        provider_request["tools"][0]["input_schema"]["properties"]["provider_protocol"]["type"],
        json!("string")
    );
}

#[test]
fn side_channel_and_protocol_fields_cannot_enter_anthropic_payloads() {
    for leaked in [
        "routecodex_internal",
        "metadata_center",
        "debug_snapshot",
        "provider_protocol",
        "resource_handle",
    ] {
        let mut payload = json!({"messages":[]});
        payload
            .as_object_mut()
            .unwrap()
            .insert(leaked.to_string(), json!({"leak":true}));
        assert!(matches!(
            characterize_v3_anthropic_client_input_to_hub_semantic(
                payload,
                V3HubEntryProtocol::Anthropic,
                V3HubTransportIntent::Json,
            ),
            Err(V3AnthropicCodecError::SideChannelLeaked { .. })
        ));
    }
    assert!(matches!(
        characterize_v3_anthropic_client_input_to_hub_semantic(
            json!({"messages":[]}),
            V3HubEntryProtocol::Responses,
            V3HubTransportIntent::Json,
        ),
        Err(V3AnthropicCodecError::EntryProtocolNotAnthropic)
    ));
}

fn base_chat_for_field_projection() -> serde_json::Value {
    json!({
        "model":"claude-test",
        "messages":[{"role":"user","content":"hello"}],
        "max_tokens":4096
    })
}

#[test]
fn anthropic_thinking_fields_require_valid_exact_shape() {
    let mut enabled = base_chat_for_field_projection();
    enabled["reasoning_thinking_mode"] = json!("enabled");
    enabled["reasoning_budget_tokens"] = json!(2048);
    enabled["reasoning_display_policy"] = json!("omitted");
    let wire = encode_v3_responses_semantic_as_anthropic_request(enabled)
        .expect("valid enabled thinking must project exactly");
    assert_eq!(
        wire["thinking"],
        json!({"type":"enabled","budget_tokens":2048,"display":"omitted"})
    );

    let mut missing_budget = base_chat_for_field_projection();
    missing_budget["reasoning_thinking_mode"] = json!("enabled");
    assert!(encode_v3_responses_semantic_as_anthropic_request(missing_budget).is_err());

    let mut disabled_with_budget = base_chat_for_field_projection();
    disabled_with_budget["reasoning_thinking_mode"] = json!("disabled");
    disabled_with_budget["reasoning_budget_tokens"] = json!(2048);
    assert!(encode_v3_responses_semantic_as_anthropic_request(disabled_with_budget).is_err());

    let mut excessive_budget = base_chat_for_field_projection();
    excessive_budget["reasoning_thinking_mode"] = json!("enabled");
    excessive_budget["reasoning_budget_tokens"] = json!(4096);
    assert!(encode_v3_responses_semantic_as_anthropic_request(excessive_budget).is_err());
}

#[test]
fn anthropic_client_metadata_projects_user_id_consumes_registered_local_context_and_rejects_unknown(
) {
    let mut exact = base_chat_for_field_projection();
    exact["routecodex_chat_extension"] = json!({
        "responses_request":{"client_metadata":{"user_id":"opaque-user"}}
    });
    let wire = encode_v3_responses_semantic_as_anthropic_request(exact)
        .expect("exact client_metadata.user_id must project");
    assert_eq!(wire["metadata"], json!({"user_id":"opaque-user"}));

    let mut session = base_chat_for_field_projection();
    session["routecodex_chat_extension"] =
        json!({"responses_request":{"client_metadata":{"session_id":"session"}}});
    let wire = encode_v3_responses_semantic_as_anthropic_request(session)
        .expect("registered Codex session identity is consumed as local context");
    assert!(wire.get("metadata").is_none(), "{wire}");

    let mut unsupported = base_chat_for_field_projection();
    unsupported["routecodex_chat_extension"] =
        json!({"responses_request":{"client_metadata":{"turn":"unsupported"}}});
    let error = encode_v3_responses_semantic_as_anthropic_request(unsupported)
        .expect_err("unknown client_metadata must remain fail-fast");
    assert!(error.to_string().contains("client_metadata.turn"));
}

#[test]
fn anthropic_public_metadata_projects_user_id_and_consumes_response_context() {
    let mut exact = base_chat_for_field_projection();
    exact["routecodex_chat_extension"] = json!({
        "responses_request":{"metadata":{"user_id":"public-user"}}
    });
    let wire = encode_v3_responses_semantic_as_anthropic_request(exact)
        .expect("exact public metadata.user_id must project");
    assert_eq!(wire["metadata"], json!({"user_id":"public-user"}));

    let mut unsupported = base_chat_for_field_projection();
    unsupported["routecodex_chat_extension"] = json!({
        "responses_request":{"metadata":{"tenant":"tenant-1"}}
    });
    let wire = encode_v3_responses_semantic_as_anthropic_request(unsupported)
        .expect("public metadata without an Anthropic slot stays response projection context");
    assert!(wire.get("metadata").is_none(), "{wire}");
}

#[test]
fn anthropic_consumes_registered_responses_cache_verbosity_store_false_and_rejects_invalid() {
    let mut cache_key = base_chat_for_field_projection();
    cache_key["routecodex_chat_extension"] = json!({"responses_request":{
        "prompt_cache_key":"session-1",
    }});
    let wire = encode_v3_responses_semantic_as_anthropic_request(cache_key)
        .expect("valid prompt_cache_key is consumed as local cache hint");
    assert!(!serde_json::to_string(&wire)
        .unwrap()
        .contains("prompt_cache_key"));

    let mut verbosity = base_chat_for_field_projection();
    verbosity["routecodex_chat_extension"] =
        json!({"responses_request":{"text":{"verbosity":"high"}}});
    let wire = encode_v3_responses_semantic_as_anthropic_request(verbosity)
        .expect("Responses verbosity is consumed as local style hint");
    assert!(!serde_json::to_string(&wire).unwrap().contains("verbosity"));

    let mut not_stored = base_chat_for_field_projection();
    not_stored["routecodex_chat_extension"] = json!({"responses_request":{"store":false}});
    let wire = encode_v3_responses_semantic_as_anthropic_request(not_stored)
        .expect("store=false is semantically equivalent to omitting Anthropic storage");
    assert!(wire.get("store").is_none(), "{wire}");

    let mut stored = base_chat_for_field_projection();
    stored["routecodex_chat_extension"] = json!({"responses_request":{"store":true}});
    let error = encode_v3_responses_semantic_as_anthropic_request(stored)
        .expect_err("store=true has no Anthropic equivalent");
    assert!(error.to_string().contains("$.request.store"), "{error}");

    let mut malformed_cache_key = base_chat_for_field_projection();
    malformed_cache_key["routecodex_chat_extension"] =
        json!({"responses_request":{"prompt_cache_key":""}});
    let error = encode_v3_responses_semantic_as_anthropic_request(malformed_cache_key)
        .expect_err("empty prompt_cache_key must fail target validation");
    assert!(error.to_string().contains("prompt_cache_key"), "{error}");

    let mut malformed_verbosity = base_chat_for_field_projection();
    malformed_verbosity["routecodex_chat_extension"] =
        json!({"responses_request":{"text":{"verbosity":"verbose"}}});
    let error = encode_v3_responses_semantic_as_anthropic_request(malformed_verbosity)
        .expect_err("unknown verbosity must fail target validation");
    assert!(error.to_string().contains("verbosity"), "{error}");
}

#[test]
fn anthropic_consumes_arbitrary_responses_metadata_without_provider_wire_leak() {
    let mut request = base_chat_for_field_projection();
    request["routecodex_chat_extension"] = json!({
        "responses_request": {
            "metadata": {
                "client_owned": "audit-20260803",
                "trace_label": "client-data"
            }
        }
    });

    let wire = encode_v3_responses_semantic_as_anthropic_request(request.clone())
        .expect("Responses metadata must remain response-owned data-plane context");

    assert!(wire.get("metadata").is_none(), "{wire}");
    let serialized = serde_json::to_string(&wire).unwrap();
    assert!(!serialized.contains("client_owned"), "{wire}");
    assert!(!serialized.contains("trace_label"), "{wire}");

    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&request)
        .expect("Responses metadata projection context");
    let response = project_v3_anthropic_message_as_responses_response_with_context(
        &json!({
            "id":"msg_metadata",
            "role":"assistant",
            "content":[{"type":"text","text":"ok"}],
            "stop_reason":"end_turn"
        }),
        &context,
    )
    .expect("Anthropic response must restore Responses metadata before RespChatProcess");
    assert_eq!(
        response["metadata"],
        json!({"client_owned":"audit-20260803","trace_label":"client-data"})
    );
}

#[test]
fn anthropic_reasoning_effort_preserves_high_effort_intersection_values() {
    for effort in ["xhigh", "max"] {
        let provider_request = encode_v3_responses_semantic_as_anthropic_request(json!({
            "model":"MiniMax-M3",
            "stream": false,
            "reasoning_effort": effort,
            "messages":[{"role":"user","content":"preserve effort"}]
        }))
        .expect("Anthropic effort projection must preserve declared intersection values");

        assert_eq!(provider_request["output_config"]["effort"], effort);
    }
}

#[test]
fn anthropic_rejects_unmapped_responses_text_format_nested_fields() {
    let mut json_schema_name = base_chat_for_field_projection();
    json_schema_name["routecodex_chat_extension"] = json!({"responses_request":{"text":{"format":{
        "type":"json_schema",
        "name":"contract_name",
        "schema":{"type":"object"}
    }}}});
    let error = encode_v3_responses_semantic_as_anthropic_request(json_schema_name)
        .expect_err("Anthropic cannot preserve Responses json_schema.name");
    assert!(
        error
            .to_string()
            .contains("$.request.text.output_config.format.name"),
        "{error}"
    );

    let mut text_extra = base_chat_for_field_projection();
    text_extra["routecodex_chat_extension"] =
        json!({"responses_request":{"text":{"format":{"type":"text","description":"strict"}}}});
    let error = encode_v3_responses_semantic_as_anthropic_request(text_extra)
        .expect_err("Anthropic cannot preserve extra text format fields");
    assert!(
        error
            .to_string()
            .contains("$.request.text.output_config.format.description"),
        "{error}"
    );

    let mut malformed_strict = base_chat_for_field_projection();
    malformed_strict["routecodex_chat_extension"] = json!({"responses_request":{"text":{"format":{
        "type":"json_schema",
        "strict":"false",
        "schema":{"type":"object"}
    }}}});
    let error = encode_v3_responses_semantic_as_anthropic_request(malformed_strict)
        .expect_err("malformed strict must fail before dropping structured-output semantics");
    assert!(error.to_string().contains("format.strict"), "{error}");
}
