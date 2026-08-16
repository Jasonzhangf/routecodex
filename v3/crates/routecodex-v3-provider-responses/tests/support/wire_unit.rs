#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const VALID_PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    #[test]
    fn wire_accepts_only_prebound_selected_model() {
        let body = json!({
            "model":"upstream-model",
            "input":"hello",
            "metadata":{"client":"kept"},
            "unknown_client_field":true
        });
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-1",
            V3ResponsesProviderTarget {
                provider_id: "neutral-provider".into(),
                provider_type: "responses".into(),
                base_url: "http://upstream.invalid/v1".into(),
                canonical_model_id: "canonical-model".into(),
                wire_model: "upstream-model".into(),
                compatibility_profile: None,
                auth: V3ProviderAuthHandle {
                    alias: "primary".into(),
                    secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
                },
                responses_transport: V3ResponsesTransportKind::Http,
                websocket_v2_url: None,
                provider_request_cleanup: Default::default(),
                request_timeout_ms: 300_000,
                initial_concurrency_budget: 8,
            },
            body,
        )
        .unwrap();
        assert_eq!(wire.body()["model"], "upstream-model");
        assert_eq!(wire.body()["input"], "hello");
        assert_eq!(wire.body()["metadata"], json!({"client":"kept"}));
        assert_eq!(wire.body()["unknown_client_field"], true);
        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Json);
    }

    #[test]
    fn wire_preserves_historical_tool_output_data_images_byte_for_byte() {
        let current_user_image = VALID_PNG_DATA_URL;
        let current_tool_image = VALID_PNG_DATA_URL;
        let body = json!({
            "model": "upstream-model", "stream": true, "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "old turn"}]},
                {"type": "function_call", "name": "view_image", "call_id": "call_old", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "call_old", "output": [
                    {"type": "input_image", "image_url": "data:image/png;base64,OLD", "detail": "high"},
                    {"type": "input_image", "image_url": {"url": "data:image/png;base64,OLD_OBJECT"}, "detail": "low"},
                    {"type": "input_text", "text": "tool text stays"}
                ]},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"},
                    {"type": "input_image", "image_url": current_user_image}
                ]},
                {"type": "function_call_output", "call_id": "call_after_latest_user", "output": [
                    {"type": "input_image", "image_url": current_tool_image}
                ]}
            ]
        });
        let expected = body.clone();
        let wire =
            build_v3_provider_12_responses_wire_payload("req-images", target(), body).unwrap();
        assert_eq!(wire.body(), &expected);
        assert_eq!(wire.stream_intent(), V3ResponsesStreamIntent::Sse);
    }

    #[test]
    fn wire_does_not_broadly_replace_text_or_non_data_historical_tool_images() {
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "message", "role": "user", "content": "old turn"},
                {"type": "function_call_output", "call_id": "call_old", "output": [
                    {"type": "input_text", "text": "literal data:image/png;base64,TEXT stays text"},
                    {"type": "input_image", "image_url": "https://example.invalid/old.png"}
                ]},
                {"type": "message", "role": "user", "content": "latest turn"}
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-no-broad", target(), body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(
            input[1]["output"][0]["text"],
            "literal data:image/png;base64,TEXT stays text"
        );
        assert_eq!(
            input[1]["output"][1]["image_url"],
            "https://example.invalid/old.png"
        );
    }

    #[test]
    fn wire_preserves_historical_reasoning_even_when_legacy_cleanup_is_configured() {
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "message", "role": "user", "content": "old turn"},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "old summary"}], "encrypted_content": "rsn_old_foreign"},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "literal rsn_text_stays"}]},
                {"type": "message", "role": "user", "content": "latest turn"},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "current summary"}], "encrypted_content": "rsn_current_same_turn"}
            ]
        });
        let expected = body.clone();
        // gpt 目标（OpenAI 官方 canonical）保留 encrypted_content 透传；
        // 本测试验证 legacy cleanup 配置不会剥离密文（cleanup 仅处理历史字段名，非密文语义）。
        let mut gpt_target = cleanup_target(&["reasoning.encrypted_content"]);
        gpt_target.canonical_model_id = "gpt-5.6-sol".into();
        let wire =
            build_v3_provider_12_responses_wire_payload("req-encrypted-history", gpt_target, body)
                .unwrap();
        assert_eq!(wire.body(), &expected);
    }

    #[test]
    fn wire_preserves_historical_encrypted_content_when_cleanup_is_not_configured() {
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "message", "role": "user", "content": "old turn"},
                {"type": "reasoning", "encrypted_content": "rsn_old_same_provider"},
                {"type": "message", "role": "user", "content": "latest turn"}
            ]
        });
        // gpt 目标（OpenAI 官方 canonical）保留 encrypted_content 透传。
        let mut gpt_target = target();
        gpt_target.canonical_model_id = "gpt-5.6-sol".into();
        let wire = build_v3_provider_12_responses_wire_payload("req-no-cleanup", gpt_target, body)
            .unwrap();
        assert_eq!(
            wire.body()["input"][1]["encrypted_content"],
            "rsn_old_same_provider"
        );
    }

    #[test]
    fn current_turn_invalid_png_data_image_is_rejected_before_provider_transport() {
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "current turn"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
                ]}
            ]
        });
        let error =
            build_v3_provider_12_responses_wire_payload("req-invalid-image", target(), body)
                .expect_err("invalid current-turn data image must fail before provider transport");
        assert!(error.to_string().contains("invalid data:image/png payload"));
    }

    #[test]
    fn non_object_or_non_boolean_stream_fails_without_rebuilding_payload() {
        let target = V3ResponsesProviderTarget {
            provider_id: "neutral-provider".into(),
            provider_type: "responses".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "model".into(),
            wire_model: "model".into(),
            compatibility_profile: None,
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
        };
        assert!(matches!(
            build_v3_provider_12_responses_wire_payload("req-array", target.clone(), json!([])),
            Err(V3ProviderError::InvalidWireBody { .. })
        ));
        assert!(matches!(
            build_v3_provider_12_responses_wire_payload(
                "req-stream",
                target,
                json!({"stream":"yes"})
            ),
            Err(V3ProviderError::InvalidStreamIntent { .. })
        ));
    }

    #[test]
    fn wire_rejects_routecodex_control_keys_before_provider_transport() {
        let body = json!({
            "model":"upstream-model", "input":[{
                "role":"user", "content":"hello",
                "metadataCenter":{"provider_key":"must-not-leak"}
            }],
            "metadata":{"client":"kept"},
            "client_metadata":{"session_id":"client-owned"}
        });
        let error = build_v3_provider_12_responses_wire_payload("req-control", target(), body)
            .expect_err("provider wire body must reject internal control fields");
        assert!(matches!(
            error,
            V3ProviderError::ControlFieldInWireBody {
                request_id,
                field: "metadataCenter"
            } if request_id == "req-control"
        ));
    }

    #[test]
    fn wire_flattens_namespace_tool_children_into_function_tools() {
        let body = json!({
            "model": "upstream-model", "input": "hello", "tools": [
                {"type": "function", "name": "plain_tool", "description": "d", "parameters": {"type": "object"}},
                {"type": "namespace", "name": "mcp__node_repl", "tools": [
                    {"type": "function", "name": "mcp__node_repl__js", "description": "run js", "parameters": {"type": "object", "properties": {}}, "strict": false},
                    {"type": "function", "name": "mcp__node_repl__npm", "description": "npm", "parameters": {"type": "object", "properties": {}}}
                ]}
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-namespace", target(), body).unwrap();
        let tools = wire.body()["tools"].as_array().expect("tools array");
        assert_eq!(
            tools.len(),
            3,
            "namespace container must be replaced by its children: {tools:?}"
        );
        assert_eq!(tools[0]["type"], json!("function"));
        assert_eq!(
            tools[1],
            json!({
                "type": "function", "name": "mcp__node_repl__js", "description": "run js",
                "parameters": {"type": "object", "properties": {}}, "strict": false
            })
        );
        assert_eq!(tools[2]["type"], json!("function"));
        assert_eq!(tools[2]["name"], json!("mcp__node_repl__npm"));
        assert!(
            tools.iter().all(|tool| tool["type"] != json!("namespace")),
            "no namespace container may cross provider wire payload: {tools:?}"
        );
    }

    #[test]
    fn wire_namespace_tool_empty_children_fails_explicitly() {
        let body = json!({
            "model": "upstream-model", "input": "hello", "tools": [
                {"type": "namespace", "name": "mcp__node_repl", "tools": []}
            ]
        });
        let error = build_v3_provider_12_responses_wire_payload("req-empty-ns", target(), body)
            .expect_err("empty namespace container must fail explicitly, not reach provider");
        assert!(matches!(
            error,
            V3ProviderError::NamespaceToolFlattenFailed { request_id, .. } if request_id == "req-empty-ns"
        ));
    }

    #[test]
    fn wire_flattens_namespace_children_into_dual_field_functions_for_openai_chat_provider() {
        let mut chat_target = target();
        chat_target.provider_type = "openai_chat".into();
        let body = json!({
            "model": "upstream-model", "input": "hello", "tools": [
                {"type": "function", "function": {"name": "plain_tool", "description": "d", "parameters": {"type": "object"}}},
                {"type": "namespace", "name": "mcp__node_repl", "tools": [
                    {"type": "function", "name": "mcp__node_repl__js", "description": "run js", "parameters": {"type": "object", "properties": {}}, "strict": false},
                    {"type": "function", "name": "mcp__node_repl__npm", "description": "npm", "parameters": {"type": "object", "properties": {}}}
                ]}
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-ns-chat", chat_target, body).unwrap();
        let tools = wire.body()["tools"].as_array().expect("tools array");
        assert_eq!(
            tools.len(),
            3,
            "namespace container must be replaced by its children: {tools:?}"
        );
        assert_eq!(
            tools[0],
            json!({
                "type": "function", "name": "plain_tool",
                "function": {"name": "plain_tool", "description": "d", "parameters": {"type": "object"}}
            }),
            "Console Go requires dual-field tools (top-level name + nested function): {:?}",
            tools[0]
        );
        assert_eq!(
            tools[1],
            json!({
                "type": "function", "name": "mcp__node_repl__js",
                "function": {
                    "name": "mcp__node_repl__js", "description": "run js",
                    "parameters": {"type": "object", "properties": {}}, "strict": false
                }
            }),
            "Console Go requires dual-field tools (top-level name + nested function): {:?}",
            tools[1]
        );
        assert_eq!(tools[2]["type"], json!("function"));
        assert_eq!(tools[2]["name"], json!("mcp__node_repl__npm"));
        assert_eq!(tools[2]["function"]["name"], json!("mcp__node_repl__npm"));
        assert!(
            tools.iter().all(|tool| tool["type"] != json!("namespace")),
            "no namespace container may cross provider wire payload: {tools:?}"
        );
    }

    #[test]
    fn openai_chat_normalizes_flat_client_function_tools_to_dual_field_without_namespace() {
        let mut chat_target = target();
        chat_target.provider_type = "openai_chat".into();
        // OneStop 会话实际形状：无 namespace、纯嵌套 function（缺顶层 name），
        // 原样透传会导致 Console Go 上游 400 missing field `name`。
        let body = json!({
            "model": "upstream-model", "input": "say hi in one word", "tools": [
                {"type": "function", "function": {"name": "plain_tool", "description": "d", "parameters": {"properties": {}, "type": "object"}}}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-chat-plain", chat_target, body)
            .unwrap();
        let tools = wire.body()["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0],
            json!({
                "type": "function", "name": "plain_tool",
                "function": {"name": "plain_tool", "description": "d", "parameters": {"properties": {}, "type": "object"}}
            }),
            "Console Go rejects nested-only tools; wire must add top-level name: {:?}",
            tools[0]
        );
    }

    #[test]
    fn openai_responses_provider_keeps_flat_tool_shape_untouched() {
        let body = json!({
            "model": "upstream-model", "input": "hello", "tools": [
                {"type": "function", "name": "plain_tool", "description": "d", "parameters": {"type": "object", "properties": {}}}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-flat", target(), body).unwrap();
        assert_eq!(
            wire.body()["tools"],
            json!([
                {"type": "function", "name": "plain_tool", "description": "d", "parameters": {"type": "object", "properties": {}}}
            ]),
            "standard responses provider must keep flat function shape unchanged"
        );
    }

    #[test]
    fn wire_rejects_routing_capability_control_keys_before_provider_transport() {
        let body = json!({
            "model":"upstream-model", "input":"hello", "request_capabilities":["vision"]
        });
        let error = build_v3_provider_12_responses_wire_payload("req-cap", target(), body)
            .expect_err("request capability facts are control-plane, not provider payload");
        assert!(matches!(
            error,
            V3ProviderError::ControlFieldInWireBody {
                request_id,
                field: "request_capabilities"
            } if request_id == "req-cap"
        ));
    }

    #[test]
    fn canonical_control_key_guard_rejects_route_facts_and_keeps_client_metadata_data_plane() {
        assert!(!V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS.contains(&"metadata"));
        assert!(!V3_ROUTECODEX_CONTROL_PAYLOAD_KEYS.contains(&"client_metadata"));
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "metadata": {"client": "kept"},
                "client_metadata": {"session_id": "client-owned"}
            })),
            None
        );
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "input": "hello", "routeHint": {"route": "must-not-enter-wire"}
            })),
            Some("routeHint")
        );
        assert_eq!(
            find_v3_routecodex_control_payload_key(&json!({
                "input": "hello", "opaque_target": {"target": "must-not-enter-wire"}
            })),
            Some("opaque_target")
        );
    }

    #[test]
    fn opencode_go_deepseek_responses_wire_omits_thinking_stopless_tool_choice() {
        let mut selected = target();
        selected.provider_id = "opencode-go".into();
        selected.provider_type = "openai_chat".into();
        selected.canonical_model_id = "deepseek-v4-flash".into();
        selected.wire_model = "deepseek-v4-flash".into();
        let wire = build_v3_provider_12_responses_wire_payload("req-deepseek-stopless", selected, json!({
            "model": "deepseek-v4-flash", "input": "continue",
            "reasoning": {"effort": "high"}, "tool_choice": "required",
            "tools": [{"type": "function", "name": "reasoningStop", "description": "stopless control"}]
        }))
        .expect("DeepSeek Responses wire must not reject Stopless thinking mode");
        assert!(wire.body().get("tool_choice").is_none());
        assert!(wire.body()["tools"].as_array().is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str) == Some("reasoningStop")
            })
        }));
    }

    fn target() -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: "neutral-provider".into(),
            provider_type: "responses".into(),
            base_url: "http://upstream.invalid/v1".into(),
            canonical_model_id: "canonical-model".into(),
            wire_model: "upstream-model".into(),
            compatibility_profile: None,
            auth: V3ProviderAuthHandle {
                alias: "primary".into(),
                secret: V3ProviderAuthSecretHandle::Environment("NEUTRAL_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
            provider_request_cleanup: Default::default(),
            request_timeout_ms: 300_000,
            initial_concurrency_budget: 8,
        }
    }

    fn cleanup_target(fields: &[&str]) -> V3ResponsesProviderTarget {
        let mut target = target();
        target.provider_request_cleanup.historical_fields =
            fields.iter().map(|field| field.to_string()).collect();
        target
    }

    #[test]
    fn wire_strips_encrypted_reasoning_content_for_non_gpt_target() {
        let mut target = target();
        target.canonical_model_id = "deepseek-v4-flash".into();
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "reasoning", "id": "item_rsn_1", "summary": [{"type": "summary_text", "text": "plain summary"}], "encrypted_content": "rsn_encrypted", "content": null},
                {"type": "reasoning", "id": "item_rsn_2", "encrypted_content": "rsn_only", "content": null, "summary": null},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "user turn"}]}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-1", target, body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(
            input.len(),
            3,
            "both reasoning items are kept (non-gpt wire must carry every assistant reasoning representation)"
        );
        assert_eq!(input[0]["type"], "reasoning");
        assert_eq!(
            input[0]["content"],
            json!([{"type": "reasoning_text", "text": "plain summary"}])
        );
        assert!(
            input[0].get("summary").is_none(),
            "summary must be dropped once mapped into content.reasoning_text"
        );
        assert!(
            input[0].get("encrypted_content").is_none(),
            "encrypted_content must be stripped for non-gpt target"
        );
        assert_eq!(input[1]["type"], "reasoning");
        assert_eq!(input[1]["content"], json!([{"type": "reasoning_text", "text": "[thinking redacted]"}]), "empty reasoning item becomes non-empty content.reasoning_text placeholder; empty or missing reasoning_text triggers upstream 400 `reasoning_text must be passed back`");
        assert!(
            input[1].get("summary").is_none(),
            "empty placeholder must be content-only"
        );
        assert!(
            input[1].get("encrypted_content").is_none(),
            "placeholder must not carry encrypted_content"
        );
        assert_eq!(input[2]["type"], "message");
    }

    #[test]
    fn wire_maps_summary_only_reasoning_to_content_for_non_gpt_target() {
        let mut target = target();
        target.canonical_model_id = "deepseek-v4-flash".into();
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "reasoning", "summary": [
                    {"type": "summary_text", "text": "first summary"},
                    {"type": "summary_text", "text": " second summary"}
                ]},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "user turn"}]}
            ]
        });
        let first =
            build_v3_provider_12_responses_wire_payload("req-1", target.clone(), body.clone())
                .unwrap();
        let second = build_v3_provider_12_responses_wire_payload("req-2", target, body).unwrap();
        assert_eq!(
            first.body()["input"][0]["content"],
            json!([{"type": "reasoning_text", "text": "first summary second summary"}])
        );
        assert!(
            first.body()["input"][0].get("summary").is_none(),
            "summary-only history must become content-only wire shape"
        );
        assert!(first.body()["input"][0].get("encrypted_content").is_none());
        assert_eq!(
            first.body(),
            second.body(),
            "reasoning wire normalization must be deterministic so repeated requests keep the same upstream cache prefix"
        );
    }

    #[test]
    fn wire_removes_null_encrypted_content_and_maps_summary_for_non_gpt_target() {
        let mut target = target();
        target.canonical_model_id = "deepseek-v4-flash".into();
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "reasoning", "id": "rs_0c9a07cb4afc20f7016a7e9f3508cc8191901c40907a61bcf9", "summary": [
                    {"type": "summary_text", "text": "**Planning task by reading SKILL.md**"},
                    {"type": "summary_text", "text": "**Preparing parallel reads of project files**"}
                ], "encrypted_content": null},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "user turn"}]}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-1", target, body).unwrap();
        let reasoning = &wire.body()["input"][0];
        assert_eq!(
            reasoning["content"],
            json!([{"type": "reasoning_text", "text": "**Planning task by reading SKILL.md****Preparing parallel reads of project files**"}])
        );
        assert!(
            reasoning.get("encrypted_content").is_none(),
            "null encrypted_content key must be removed as part of unified cipher cleanup"
        );
        assert!(
            reasoning.get("summary").is_none(),
            "summary must not remain next to content"
        );
        assert_eq!(
            reasoning["id"],
            "rs_0c9a07cb4afc20f7016a7e9f3508cc8191901c40907a61bcf9"
        );
    }

    #[test]
    fn wire_keeps_existing_content_reasoning_and_drops_summary_encrypted_for_non_gpt_target() {
        let mut target = target();
        target.canonical_model_id = "deepseek-v4-flash".into();
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "reasoning", "id": "rs_existing", "summary": [{"type": "summary_text", "text": "summary text"}], "content": [
                    {"type": "reasoning_text", "text": "existing plain content"},
                    {"type": "reasoning_text", "text": " tail"}
                ], "encrypted_content": "rsn_cipher"},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "user turn"}]}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-1", target, body).unwrap();
        let reasoning = &wire.body()["input"][0];
        assert_eq!(
            reasoning["content"],
            json!([{"type": "reasoning_text", "text": "existing plain content tail"}]),
            "existing content fragments must be joined into the single canonical reasoning_text wire shape"
        );
        assert!(reasoning.get("summary").is_none());
        assert!(reasoning.get("encrypted_content").is_none());
    }

    #[test]
    fn wire_keeps_narrow_encrypted_cleanup_for_other_non_gpt_responses_target() {
        // 非 deepseek 的 responses 目标只保留既有窄清理（剥历史密文 + 空条目占位），
        // 不做 summary -> content.reasoning_text 重写；该重写只在已证明需要的
        // DeepSeek/opencode 链路上执行，避免未经证实的其他 provider 被改写 reasoning 形态。
        let body = json!({
            "model": "upstream-model", "input": [
                {"type": "reasoning", "id": "rs_summary", "summary": [{"type": "summary_text", "text": "plain summary"}], "encrypted_content": "rsn_cipher"},
                {"type": "reasoning", "id": "rs_encrypted_only", "encrypted_content": "rsn_only", "summary": null},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "user turn"}]}
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-1", target(), body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(input.len(), 3);
        assert!(
            input[0].get("encrypted_content").is_none(),
            "cipher cleanup stays universal for non-gpt targets"
        );
        assert_eq!(
            input[0]["summary"],
            json!([{"type": "summary_text", "text": "plain summary"}]),
            "non-deepseek targets keep summary untouched"
        );
        assert!(
            input[0].get("content").is_none(),
            "no deepseek reasoning_text rewrite for unproven targets"
        );
        assert!(input[1].get("encrypted_content").is_none());
        assert_eq!(
            input[1]["text"], "[thinking redacted]",
            "encrypted-only item keeps the previous narrow placeholder"
        );
        assert!(input[1].get("content").is_none());
    }

    #[test]
    fn wire_inserts_reasoning_before_interleaved_deepseek_tool_segments() {
        // 交错工具段（function_call_output/custom_tool_call_output 后直接跟随
        // function_call/custom_tool_call）经 Console Go 转 Chat 时会产生新的
        // assistant tool_calls 消息；thinking mode 下该消息必须附着 reasoning，
        // 否则上游 400 `reasoning_text must be passed back`。wire 必须在每个
        // output->call 交界插入继承前文明文（无前文时用确定性占位符）的 reasoning
        // 条目，且重复构建字节不变。
        let mut target = target();
        target.provider_id = "opencode-go".into();
        target.provider_type = "responses".into();
        target.canonical_model_id = "deepseek-v4-flash".into();
        target.wire_model = "deepseek-v4-flash".into();
        target.compatibility_profile = Some("responses:deepseek-console-go".into());
        let body = json!({
            "model": "deepseek-v4-flash", "reasoning": {"effort": "high"}, "input": [
                {"type": "reasoning", "id": "rs_first", "summary": [{"type": "summary_text", "text": "plan first tool segment"}]},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "calling tools"}]},
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "/tmp"},
                {"type": "function_call", "call_id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
                {"type": "function_call_output", "call_id": "call_2", "output": "src"},
                {"type": "custom_tool_call", "call_id": "call_3", "name": "apply_patch", "input": "patch"},
                {"type": "custom_tool_call_output", "call_id": "call_3", "output": "ok"},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
            ]
        });
        let first = build_v3_provider_12_responses_wire_payload(
            "req-junction",
            target.clone(),
            body.clone(),
        )
        .unwrap();
        let second =
            build_v3_provider_12_responses_wire_payload("req-junction-2", target, body).unwrap();
        let input = first.body()["input"].as_array().unwrap();
        assert_eq!(
            input[0]["content"],
            json!([{"type": "reasoning_text", "text": "plan first tool segment"}])
        );
        let first_junction = input
            .windows(2)
            .position(|pair| {
                pair[0]["type"] == "function_call_output" && pair[1]["type"] == "reasoning"
            })
            .expect("first output->call junction must insert reasoning");
        assert_eq!(
            input[first_junction + 1]["content"],
            json!([{"type": "reasoning_text", "text": "plan first tool segment"}])
        );
        assert_eq!(input[first_junction + 2]["type"], "function_call");
        let second_junction = input
            .windows(2)
            .enumerate()
            .skip(first_junction + 1)
            .find(|(_, pair)| {
                pair[0]["type"] == "function_call_output" && pair[1]["type"] == "reasoning"
            })
            .map(|(index, _)| index)
            .expect("second output->call junction must insert reasoning");
        assert_eq!(input[second_junction + 1]["type"], "reasoning");
        assert_eq!(input[second_junction + 2]["type"], "custom_tool_call");
        assert_eq!(
            first.body(),
            second.body(),
            "interleaved tool segment reasoning insertion must be deterministic so repeated requests keep the same upstream cache prefix"
        );
    }

    #[test]
    fn wire_inserts_reasoning_before_first_deepseek_tool_segment() {
        let mut target = target();
        target.provider_id = "opencode-go".into();
        target.provider_type = "responses".into();
        target.canonical_model_id = "deepseek-v4-flash".into();
        target.wire_model = "deepseek-v4-flash".into();
        target.compatibility_profile = Some("responses:deepseek-console-go".into());
        let body = json!({
            "model": "deepseek-v4-flash", "reasoning": {"effort": "high"}, "input": [
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "calling tools"}]},
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{}"}
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-first-tool-segment", target, body)
                .unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(input[1]["type"], "reasoning");
        assert_eq!(input[2]["type"], "function_call");
    }

    #[test]
    fn wire_keeps_deepseek_model_interleaved_tools_untouched_for_unproven_provider() {
        // junction 兼容只属于已证实的 opencode-go/Console Go 网关；其他持
        // deepseek-v4-flash 模型的 Responses provider 没有证明需要合成 reasoning，
        // wire 不得按模型名对它们追加条目。
        let mut target = target();
        target.provider_id = "some-other-responses".into();
        target.canonical_model_id = "deepseek-v4-flash".into();
        target.wire_model = "deepseek-v4-flash".into();
        let body = json!({
            "model": "deepseek-v4-flash",
            "reasoning": {"effort": "high"},
            "input": [
                {
                    "type": "reasoning",
                    "id": "rs_first",
                    "summary": [{"type": "summary_text", "text": "plan first tool segment"}]
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "calling tools"}]
                },
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "/tmp"
                },
                {
                    "type": "function_call",
                    "call_id": "call_2",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"ls\"}"
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "continue"}]
                }
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-unproven", target, body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(
            input[4]["type"], "function_call",
            "unproven provider must keep the client's output->call sequence untouched (reasoning_text shape rewrite still applies)"
        );
    }

    #[test]
    fn wire_moves_deepseek_console_go_interleaved_assistant_after_tool_run_outputs() {
        // 已证实 400 载体（opencode-go key3 deepseek-v4-flash）：Console Go
        // 网关把 Responses input 转 Chat 时按 call -> 最近 output 配对；call
        // 与其 output 之间的 assistant 文本消息会打断配对，导致上游 400
        // `No tool output found for tool call ...`（DeepSeek 原生 API 接受该
        // 交错，只有 Console Go Chat 降级不接受）。wire 必须把每个工具 run
        // 内的 assistant 消息移到该 run 最后一个 output 之后，calls/outputs
        // 原序保留；并行 calls 的 run 同样后移，且重复构建字节不变。
        let mut target = target();
        target.provider_id = "opencode-go".into();
        target.provider_type = "responses".into();
        target.canonical_model_id = "deepseek-v4-flash".into();
        target.wire_model = "deepseek-v4-flash".into();
        target.compatibility_profile = Some("responses:deepseek-console-go".into());
        let body = json!({
            "model": "deepseek-v4-flash",
            "reasoning": {"effort": "high"},
            "input": [
                {"type": "reasoning", "id": "rs_first", "summary": [{"type": "summary_text", "text": "plan"}]},
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "retry with int"}]},
                {"type": "function_call_output", "call_id": "call_1", "output": "/tmp"},
                {"type": "function_call", "call_id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
                {"type": "function_call", "call_id": "call_3", "name": "exec_command", "arguments": "{\"cmd\":\"ls -la\"}"},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "parallel note"}]},
                {"type": "function_call_output", "call_id": "call_2", "output": "src"},
                {"type": "function_call_output", "call_id": "call_3", "output": "src2"},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
            ]
        });
        let first = build_v3_provider_12_responses_wire_payload(
            "req-pairing",
            target.clone(),
            body.clone(),
        )
        .unwrap();
        let second =
            build_v3_provider_12_responses_wire_payload("req-pairing-2", target, body).unwrap();
        let input = first.body()["input"].as_array().unwrap();
        let types: Vec<&str> = input
            .iter()
            .map(|item| item["type"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            &types[1..10],
            &[
                "function_call",
                "function_call_output",
                "message",
                "function_call",
                "function_call",
                "function_call_output",
                "function_call_output",
                "message",
                "message",
            ],
            "single-call run must become call/output/message; parallel run must become call/call/output/output/message"
        );
        // 结构化断言：任意 call 与其同名 output 之间不得夹 assistant message。
        let mut pending: Vec<(&str, usize)> = Vec::new();
        for (index, item) in input.iter().enumerate() {
            let kind = item["type"].as_str().unwrap_or("");
            match kind {
                "function_call" | "custom_tool_call" => {
                    pending.push((item["call_id"].as_str().unwrap_or(""), index));
                }
                "function_call_output" | "custom_tool_call_output" => {
                    let call_id = item["call_id"].as_str().unwrap_or("");
                    let call_index = pending
                        .iter()
                        .position(|(candidate, _)| *candidate == call_id)
                        .expect("output must match an earlier pending call");
                    let call_input_index = pending[call_index].1;
                    let gap_has_assistant =
                        input[call_input_index + 1..index].iter().any(|mid| {
                        mid["type"].as_str() == Some("message")
                            && mid["role"].as_str() == Some("assistant")
                        });
                    assert!(
                        !gap_has_assistant,
                        "no assistant message may sit between a tool call and its output"
                    );
                    pending.remove(call_index);
                }
                _ => {}
            }
        }
        assert!(pending.is_empty(), "all calls must be matched by outputs");
        assert_eq!(
            first.body(),
            second.body(),
            "pairing normalization must be deterministic so repeated requests keep the same upstream cache prefix"
        );
    }

    #[test]
    fn wire_keeps_deepseek_console_go_paired_tool_sequence_untouched() {
        // 反向：call/output 本来就相邻（run 内无 assistant）时，wire 不得移动
        // 任何条目；run output 之后的 assistant 文本不在配对窗口内，保持原位。
        let mut target = target();
        target.provider_id = "opencode-go".into();
        target.provider_type = "responses".into();
        target.canonical_model_id = "deepseek-v4-flash".into();
        target.wire_model = "deepseek-v4-flash".into();
        target.compatibility_profile = Some("responses:deepseek-console-go".into());
        let body = json!({
            "model": "deepseek-v4-flash",
            "reasoning": {"effort": "high"},
            "input": [
                {"type": "reasoning", "id": "rs_first", "summary": [{"type": "summary_text", "text": "plan"}]},
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "/tmp"},
                {"type": "function_call", "call_id": "call_2", "name": "exec_command", "arguments": "{\"cmd\":\"ls\"}"},
                {"type": "function_call_output", "call_id": "call_2", "output": "src"},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "after run text"}]},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-paired", target, body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        let types: Vec<&str> = input
            .iter()
            .map(|item| item["type"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            &types[1..8],
            &[
                "function_call",
                "function_call_output",
                "reasoning",
                "function_call",
                "function_call_output",
                "message",
                "message",
            ],
            "already-paired runs and post-run assistant text must keep their original order"
        );
    }

    #[test]
    fn wire_keeps_interleaved_assistant_untouched_for_unproven_provider() {
        // 配对重排与 junction reasoning 同门控：只属于已证实的
        // opencode-go/Console Go 网关；其他持 deepseek-v4-flash 模型的
        // Responses provider 必须原样保留客户端交错顺序。
        let mut target = target();
        target.provider_id = "some-other-responses".into();
        target.canonical_model_id = "deepseek-v4-flash".into();
        target.wire_model = "deepseek-v4-flash".into();
        let body = json!({
            "model": "deepseek-v4-flash",
            "reasoning": {"effort": "high"},
            "input": [
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "interleaved text"}]},
                {"type": "function_call_output", "call_id": "call_1", "output": "/tmp"},
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-unproven-pairing", target, body)
                .unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(input[0]["type"], "function_call");
        assert_eq!(input[1]["type"], "message");
        assert_eq!(input[1]["role"], "assistant");
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(
            input[0]["call_id"], input[2]["call_id"],
            "unproven provider must keep the client's interleaved call/assistant/output order untouched"
        );
    }

    #[test]
    fn wire_junction_reasoning_does_not_inherit_across_user_turn_boundary() {
        // 上一轮 reasoning 明文不能错配到新一轮工具段：user 消息边界后的
        // output->call 交界必须用确定性占位符（无当前轮 reasoning），否则
        // provider 会把新一轮工具段归因到旧 turn。
        let mut target = target();
        target.provider_id = "opencode-go".into();
        target.provider_type = "responses".into();
        target.canonical_model_id = "deepseek-v4-flash".into();
        target.wire_model = "deepseek-v4-flash".into();
        target.compatibility_profile = Some("responses:deepseek-console-go".into());
        let body = json!({
            "model": "deepseek-v4-flash",
            "reasoning": {"effort": "high"},
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "turn one"}]
                },
                {
                    "type": "reasoning",
                    "id": "rs_turn_one",
                    "content": [{"type": "reasoning_text", "text": "plan turn one"}]
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "calling tool one"}]
                },
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"pwd\"}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "/tmp"
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "turn two"}]
                },
                {
                    "type": "function_call",
                    "call_id": "call_2",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"ls\"}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_2",
                    "output": "src"
                },
                {
                    "type": "function_call",
                    "call_id": "call_3",
                    "name": "exec_command",
                    "arguments": "{\"cmd\":\"git status\"}"
                }
            ]
        });
        let wire =
            build_v3_provider_12_responses_wire_payload("req-cross-turn", target, body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        let junction_idx = input
            .iter()
            .enumerate()
            .find_map(|(idx, item)| {
                let prev = idx.checked_sub(1).and_then(|prev| input[prev].get("type"));
                let next = input.get(idx + 1).and_then(|next| next.get("type"));
                let is_inserted = item["type"] == "reasoning"
                    && prev
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|kind| {
                            matches!(kind, "function_call_output" | "custom_tool_call_output")
                        })
                    && next
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|kind| matches!(kind, "function_call" | "custom_tool_call"));
                is_inserted.then_some(idx)
            })
            .expect("output_2->call_3 junction must carry an inserted reasoning item");
        assert_eq!(input[junction_idx - 1]["type"], "function_call_output");
        assert_eq!(input[junction_idx + 1]["type"], "function_call");
        assert_eq!(
            input[junction_idx]["content"],
            json!([{"type": "reasoning_text", "text": "[thinking redacted]"}])
        );
    }

    #[test]
    fn wire_keeps_encrypted_reasoning_content_for_gpt_target() {
        let mut target = target();
        target.canonical_model_id = "gpt-5.6-sol".into();
        let body = json!({
            "model": "upstream-model",
            "input": [
                {
                    "type": "reasoning",
                    "id": "item_rsn_1",
                    "summary": [{"type": "summary_text", "text": "plain summary"}],
                    "encrypted_content": "rsn_encrypted"
                }
            ]
        });
        let wire = build_v3_provider_12_responses_wire_payload("req-1", target, body).unwrap();
        let input = wire.body()["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["encrypted_content"], "rsn_encrypted");
    }

    #[test]
    fn response_cipher_policy_strips_codex_cipher_but_keeps_anthropic_signature() {
        let mut payload = json!({
            "status": "completed",
            "output": [
                {
                    "type": "reasoning",
                    "id": "rs_rsn",
                    "encrypted_content": "rsn_CIPHERTEXT",
                    "summary": [{"type": "summary_text", "text": "plain"}]
                },
                {
                    "type": "reasoning",
                    "id": "rs_gaaaa",
                    "encrypted_content": "gAAAA_cipher",
                    "content": [{"type": "reasoning_text", "text": "visible"}]
                },
                {
                    "type": "reasoning",
                    "id": "rs_sig",
                    "encrypted_content": "anthropic-signature-value",
                    "summary": [{"type": "summary_text", "text": "signed"}]
                }
            ]
        });
        apply_v3_response_cipher_policy(&mut payload, false);
        assert!(
            !payload.to_string().contains("rsn_CIPHERTEXT"),
            "rsn_ cipher must be stripped"
        );
        assert!(
            !payload.to_string().contains("gAAAA_cipher"),
            "gAAAA cipher must be stripped"
        );
        assert_eq!(
            payload["output"][2]["encrypted_content"], "anthropic-signature-value",
            "non-rsn_/gAAAA signature carrier is not Codex cipher and must be kept"
        );
        assert_eq!(payload["output"][0]["summary"][0]["text"], "plain");
        assert_eq!(payload["output"][1]["content"][0]["text"], "visible");

        let mut retained =
            json!({"output": [{"type": "reasoning", "encrypted_content": "rsn_KEEP"}]});
        apply_v3_response_cipher_policy(&mut retained, true);
        assert_eq!(
            retained["output"][0]["encrypted_content"], "rsn_KEEP",
            "retain=true must keep cipher verbatim"
        );
    }
}

/// thinking 模式判定：`reasoning.effort` 或顶层 `reasoning_effort` 非空且
/// 非 "none" 才视为 thinking（`{"effort":"none"}` 显式关闭推理不是 thinking）。
fn v3_wire_payload_is_thinking_mode(body: &Value) -> bool {
    let effort = body
        .get("reasoning")
        .and_then(|reasoning| reasoning.get("effort"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none");
    if effort.is_some() {
        return true;
    }
    body.get("reasoning_effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty() && value != "none")
}
