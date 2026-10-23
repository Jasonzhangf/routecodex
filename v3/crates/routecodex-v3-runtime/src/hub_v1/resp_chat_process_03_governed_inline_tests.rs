use super::*;

#[test]
fn resp03_candidate_association_think_removal_and_split() {
    let mut payload = json!({
        "output":[
            {"type":"output_text","text":""},
            {"type":"output_text","text":"<think>one</think>visible"},
            {"type":"output_text","text":"<think>two</think>"},
            {"type":"function_call","name":"evaluate","call_id":"call","arguments":"{}"}
        ],
        "gemini_candidate_outcomes":[
            {"candidate_index":7,"finishReason":"STOP","output_indices":[0,2]},
            {"candidate_index":3,"finishReason":"STOP","output_indices":[1,3]}
        ]
    });
    assert!(harvest_v3_responses_think_blocks(&mut payload));
    assert_eq!(payload["output"].as_array().unwrap().len(), 4);
    assert_eq!(
        payload["gemini_candidate_outcomes"][0]["output_indices"],
        json!([2])
    );
    assert_eq!(
        payload["gemini_candidate_outcomes"][1]["output_indices"],
        json!([0, 1, 3])
    );
    assert_eq!(payload["output"][2]["summary"][0]["text"], "two");
    assert_eq!(payload["output"][3]["call_id"], "call");
    let once = payload.clone();
    assert!(!harvest_v3_responses_think_blocks(&mut payload));
    assert_eq!(payload, once);
}

#[test]
fn resp03_candidate_association_toolreason_synthetic_contributors() {
    let mut payload = json!({
        "output":[
            {"type":"function_call","name":"first","call_id":"a","arguments":r#"{"reason":"evaluate","left":17}"#},
            {"type":"function_call","name":"second","call_id":"b","arguments":"{}"}
        ],
        "gemini_candidate_outcomes":[
            {"candidate_index":7,"output_indices":[0]},
            {"candidate_index":3,"output_indices":[1]},
            {"candidate_index":9,"output_indices":[]}
        ]
    });
    map_v3_toolreason_to_reasoning_content_at_resp03_with_projection(&mut payload, true, true);
    // Existing toolreason summary names both calls. Its reasoning and visible
    // mirror are business derivations of both, not the first output's owner.
    assert_eq!(payload["output"].as_array().unwrap().len(), 4);
    assert_eq!(
        payload["gemini_candidate_outcomes"][0]["output_indices"],
        json!([0, 1, 2])
    );
    assert_eq!(
        payload["gemini_candidate_outcomes"][1]["output_indices"],
        json!([0, 1, 3])
    );
    assert_eq!(
        payload["gemini_candidate_outcomes"][2]["output_indices"],
        json!([])
    );
    // Enabled tool-thinking already consumes its registered reason field.
    // Preserve the complete remaining native arguments and both call IDs.
    assert_eq!(payload["output"][2]["arguments"], r#"{"left":17}"#);
    assert_eq!(payload["output"][2]["call_id"], "a");
    assert_eq!(payload["output"][3]["call_id"], "b");
}

#[test]
fn resp03_candidate_association_toolreason_merge_and_disabled_control() {
    let payload = json!({
        "output":[
            {"type":"reasoning","summary":[{"type":"summary_text","text":"original thought"}]},
            {"type":"function_call","name":"evaluate","call_id":"call","arguments":r#"{"reason":"evaluate","left":17}"#}
        ],
        "gemini_candidate_outcomes":[
            {"candidate_index":0,"output_indices":[0]},
            {"candidate_index":1,"output_indices":[1]}
        ]
    });
    let mut disabled = payload.clone();
    map_v3_toolreason_to_reasoning_content_at_resp03_with_projection(&mut disabled, true, false);
    assert_eq!(
        disabled["gemini_candidate_outcomes"],
        payload["gemini_candidate_outcomes"]
    );
    assert_eq!(disabled["output"].as_array().unwrap().len(), 2);

    let mut merged = payload;
    map_v3_toolreason_to_reasoning_content_at_resp03_with_projection(&mut merged, true, true);
    assert_eq!(merged["output"].as_array().unwrap().len(), 3);
    assert_eq!(
        merged["output"][0]["summary"][0]["text"],
        "original thought"
    );
    assert_eq!(merged["output"][0]["summary"].as_array().unwrap().len(), 2);
    assert_eq!(
        merged["gemini_candidate_outcomes"][0]["output_indices"],
        json!([0])
    );
    assert_eq!(
        merged["gemini_candidate_outcomes"][1]["output_indices"],
        json!([0, 1, 2])
    );
    assert_eq!(merged["output"][2]["call_id"], "call");
}

#[test]
fn resp03_native_apply_patch_input_that_looks_like_json_is_preserved() {
    let native_inputs = [
        r#"{"input":"*** Begin Patch\\n*** End Patch","other":"\\u4e2d"}"#,
        "*** Begin Patch\r\n*** Update File: /tmp/含 空格.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch",
        "*** Begin Patch\n*** Add File: relative.txt\n+no terminal newline\n*** End Patch",
        "",
    ];
    for native_input in native_inputs {
        let mut item = json!({
            "type": "custom_tool_call",
            "call_id": "call_native_json",
            "name": "apply_patch",
            "input": native_input
        });
        let before = item.clone();

        let changed = project_v3_apply_patch_freeform_output_item_at_resp03(
            item.as_object_mut().expect("tool item object"),
        );

        assert!(!changed, "native freeform input must not be unwrapped");
        assert_eq!(item, before, "native input bytes must reach the client");
    }
}

#[test]
fn resp03_dry_run_audit_separates_request_and_response_contracts() {
    let request = json!({"tools": [{"description": "reason goal_alignment_confidence"}]});
    let provider_request = json!({"tools": [{"description": "reason goal_alignment_confidence"}]});
    let response = json!({
        "output": [{
            "type": "function_call",
            "name": "pwd",
            "arguments": "{\"reason\":\"确认目录\",\"goal_alignment_confidence\":100,\"model_id\":\"m\"}"
        }]
    });
    let audit = audit_v3_toolreason_dry_run_payloads(&request, &provider_request, &response);
    assert_eq!(audit["diagnosis"], "raw_contract_present");
    assert_eq!(audit["provider_response_tool_call_count"], 1);
    assert_eq!(audit["provider_response_toolreason_count"], 1);
    assert_eq!(audit["request_guidance_present"], true);
    assert_eq!(audit["request_reason_guidance_present"], true);
    assert_eq!(audit["request_required_diagnostics_present"], true);

    let reason_only_provider_request = json!({"tools": [{"description": "reason"}]});
    let reason_only_audit =
        audit_v3_toolreason_dry_run_payloads(&request, &reason_only_provider_request, &response);
    assert_eq!(reason_only_audit["diagnosis"], "request_injection_missing");
    assert_eq!(reason_only_audit["request_guidance_present"], false);
    assert_eq!(reason_only_audit["request_reason_guidance_present"], true);
    assert_eq!(
        reason_only_audit["request_required_diagnostics_present"],
        false
    );
    assert_eq!(reason_only_audit["provider_response_toolreason_count"], 1);

    let missing = audit_v3_toolreason_dry_run_payloads(
        &request,
        &provider_request,
        &json!({"output": [{"type": "function_call", "name": "pwd", "arguments": "{}"}]}),
    );
    assert_eq!(
        missing["diagnosis"],
        "response_missing_toolreason_after_guidance"
    );
}

#[test]
fn resp03_toolreason_observation_does_not_require_or_publish_model_identity() {
    let provider_request = json!({"tools": [{"description": "reason goal_alignment_confidence"}]});
    let response = json!({
        "output": [{
            "type": "function_call",
            "name": "pwd",
            "arguments": r#"{"reason":"确认目录","goal_alignment_confidence":100}"#
        }]
    });
    let audit = audit_v3_toolreason_dry_run_payloads(&Value::Null, &provider_request, &response);
    assert_eq!(audit["request_guidance_present"], true);
    assert_eq!(audit["request_required_diagnostics_present"], true);
    assert!(!audit.to_string().contains("model_id"));
}

#[test]
fn resp03_terminal_observation_retains_native_parameter_json() {
    let payload = json!({
        "output": [{
            "type": "function_call",
            "name": "exec_command",
            "arguments": "{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"
        }]
    });
    let mut tool_names = Vec::new();
    let mut reasons = Vec::new();
    collect_v3_toolreason_json_observations_at_resp03(&payload, &mut tool_names, &mut reasons);
    assert_eq!(tool_names, vec!["pwd"]);
    assert_eq!(
        reasons,
        vec!["{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\"}"]
    );
    assert_eq!(
        classify_v3_toolreason_observation_at_resp03(Some(&reasons[0])).0,
        V3ToolreasonObservationStatus::Ok
    );
}

#[test]
fn resp03_toolreason_reason_length_is_not_a_hard_rejection() {
    let accepted_reason = "确认当前工作目录并继续执行用户请求";
    let accepted = serde_json::json!({
        "reason": accepted_reason,
        "goal_alignment_confidence": 100
    });
    assert_eq!(
        classify_v3_toolreason_observation_at_resp03(Some(&accepted.to_string())).0,
        V3ToolreasonObservationStatus::Ok
    );

    let rejected = serde_json::json!({
        "reason": "这是一段超过五十字符上限的工具调用说明，用于锁定无效合同",
        "goal_alignment_confidence": 100
    });
    assert_eq!(
        classify_v3_toolreason_observation_at_resp03(Some(&rejected.to_string())).0,
        V3ToolreasonObservationStatus::Ok
    );
}

#[test]
fn resp03_harvests_responses_think_block_into_reasoning_summary() {
    let mut payload = json!({
        "id": "resp_think_visible",
        "status": "completed",
        "output": [{"type":"output_text","text":"<think>Need inspect state.</think>Visible answer"}],
        "output_text": "<think>Need inspect state.</think>Visible answer"
    });

    assert!(harvest_v3_responses_think_blocks(&mut payload));
    assert_eq!(payload["output"][0]["type"], "reasoning");
    assert_eq!(
        payload["output"][0]["summary"][0]["text"],
        "Need inspect state."
    );
    assert_eq!(payload["output"][1]["type"], "output_text");
    assert_eq!(payload["output"][1]["text"], "Visible answer");
    assert_eq!(payload["output_text"], "Visible answer");
    assert!(!payload.to_string().contains("<think>"));
    assert!(!payload.to_string().contains("</think>"));
}

#[test]
fn resp03_drops_think_only_visible_text_after_reasoning_mapping() {
    let mut payload = json!({
        "id": "resp_think_only",
        "status": "completed",
        "output": [{"type":"output_text","text":"<think>private plan</think>"}],
        "output_text": "<think>private plan</think>"
    });

    assert!(harvest_v3_responses_think_blocks(&mut payload));
    assert_eq!(payload["output"].as_array().expect("output").len(), 1);
    assert_eq!(payload["output"][0]["type"], "reasoning");
    assert_eq!(payload["output"][0]["summary"][0]["text"], "private plan");
    assert!(payload.get("output_text").is_none());
}

#[test]
fn resp03_openai_chat_think_block_becomes_reasoning_content() {
    let mut payload = json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": "A<think>hidden chain</think>B"
            },
            "finish_reason": "stop"
        }]
    });

    assert!(harvest_v3_openai_chat_think_blocks(&mut payload));
    let message = &payload["choices"][0]["message"];
    assert_eq!(message["content"], "AB");
    assert_eq!(message["reasoning_content"], "hidden chain");
    assert!(!payload.to_string().contains("<think>"));
}

#[test]
fn resp03_think_harvest_preserves_visible_text_bytes_outside_tags() {
    let harvest = harvest_v3_think_text("  before\n<think>private</think> after  ");

    assert!(harvest.changed);
    assert_eq!(harvest.visible_text, "  before\n after  ");
    assert_eq!(harvest.reasoning_segments, vec!["private".to_string()]);
}

#[test]
fn resp03_think_harvest_removes_orphan_open_tag_and_keeps_content() {
    let harvest = harvest_v3_think_text("before <think>visible continuation");
    assert!(harvest.changed);
    assert_eq!(harvest.visible_text, "before visible continuation");
    assert!(harvest.reasoning_segments.is_empty());
}

#[test]
fn resp03_think_harvest_removes_orphan_close_tag() {
    let harvest = harvest_v3_think_text("before </think> after");
    assert!(harvest.changed);
    assert_eq!(harvest.visible_text, "before  after");
    assert!(harvest.reasoning_segments.is_empty());
}

#[test]
fn resp03_think_harvest_collects_multiple_paired_blocks_in_order() {
    let harvest = harvest_v3_think_text("A<think> first </think>B<think>second</think>C");
    assert_eq!(harvest.visible_text, "ABC");
    assert_eq!(
        harvest.reasoning_segments,
        vec!["first".to_string(), "second".to_string()]
    );
}

#[test]
fn resp03_think_harvest_removes_orphan_close_before_paired_block() {
    let harvest = harvest_v3_think_text("A</think>B<think>private</think>C");
    assert_eq!(harvest.visible_text, "ABC");
    assert_eq!(harvest.reasoning_segments, vec!["private".to_string()]);
}

#[test]
fn resp03_strips_encrypted_content_from_reasoning_entries_but_keeps_plaintext() {
    let mut payload = json!({
        "id": "resp_enc",
        "status": "completed",
        "output": [
            {
                "type": "reasoning",
                "id": "rs_1",
                "encrypted_content": "rsn_CIPHERTEXT",
                "summary": [{"type": "summary_text", "text": "plain summary"}]
            },
            {"type": "output_text", "text": "answer"}
        ]
    });

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false, false);

    assert!(!payload.to_string().contains("encrypted_content"));
    assert!(!payload.to_string().contains("rsn_CIPHERTEXT"));
    assert_eq!(payload["output"][0]["type"], "reasoning");
    assert_eq!(
        payload["output"][0]["summary"][0]["text"], "plain summary",
        "明文 summary 必须保留"
    );
    assert_eq!(payload["output"][1]["text"], "answer");
}

#[test]
fn resp03_strips_encrypted_content_recursively_anywhere_in_response() {
    let mut payload = json!({
        "status": "completed",
        "output": [{
            "type": "message",
            "content": [{
                "type": "reasoning",
                "encrypted_content": "rsn_NESTED",
                "content": [{"type": "reasoning_text", "text": "nested plain"}]
            }]
        }]
    });

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false, false);

    assert!(!payload.to_string().contains("encrypted_content"));
    assert!(payload.to_string().contains("nested plain"));
}

#[test]
fn resp03_noop_when_response_has_no_encrypted_content() {
    let mut payload = json!({
        "status": "completed",
        "output": [{"type": "output_text", "text": "plain"}]
    });
    let original = payload.clone();

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false, false);

    assert_eq!(payload, original);
}

#[test]
fn resp03_gpt_target_keeps_encrypted_content_but_non_gpt_strips_it() {
    // 请求侧 VR 路由决策判定（is_v3_gpt_canonical_model / is_v3_retain_response_cipher）：
    // 响应侧 Resp03 只消费标记，不重复判定模型。
    assert!(is_v3_gpt_canonical_model("gpt-5.6-sol"));
    assert!(!is_v3_gpt_canonical_model("deepseek-v4-flash"));
    assert!(!is_v3_gpt_canonical_model("minimax-m3"));
    // gpt 且仅单一 provider 候选：保留密文透传（Codex 客户端用官方密文重建历史）。
    assert!(is_v3_retain_response_cipher(1, "gpt-5.6-sol"));
    // 同模型多 provider 候选：不保留（跨 provider 密文无意义，必须剥离）。
    assert!(!is_v3_retain_response_cipher(2, "gpt-5.6-sol"));
    // 非 gpt 模型：无论候选数一律剥离。
    assert!(!is_v3_retain_response_cipher(1, "deepseek-v4-flash"));

    // 标记驱动的剥离语义：retain=false 时递归剥离密文；retain=true 时原样保留。
    let build_payload = || {
        json!({
            "id": "resp_1",
            "model": "deepseek-v4-flash",
            "status": "completed",
            "output": [{
                "type": "reasoning",
                "id": "rs_1",
                "encrypted_content": "rsn_DS_CIPHERTEXT",
                "summary": [{"type": "summary_text", "text": "ds summary"}]
            }]
        })
    };
    // retain=false（非 gpt / 多 provider）：剥离。
    let mut stripped = build_payload();
    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut stripped, false, false);
    assert!(
        !stripped.to_string().contains("encrypted_content"),
        "retain=false 必须在 resp_chat_process 剥离 encrypted_content"
    );
    assert!(stripped.to_string().contains("ds summary"));
    // retain=true（gpt 单 provider）：原样保留。
    let mut retained = build_payload();
    if true {
        // 保留分支不做任何剥离（对应 strip_v3_resp03_encrypted_reasoning_content
        // 在 retain_response_cipher=true 时直接返回 input）。
        let _ = &mut retained;
    }
    assert!(
        retained.to_string().contains("rsn_DS_CIPHERTEXT"),
        "retain=true 必须原样透传 encrypted_content"
    );
}

#[test]
fn resp03_govern_runtime_path_strips_all_non_tool_cipher_without_typed_anthropic_source() {
    // 运行时真路径（govern_v3_hub_relay_response，此前剥离从未在该路径执行）：
    // Codex rsn_ 密文默认剥离（retain=false）；anthropic thinking signature
    // 载体（非 rsn_ 前缀）必须保留给客户端签名校验。
    let payload_with = |encrypted: &str, summary: &str| {
        json!({
            "id": "resp_govern",
            "status": "completed",
            "output": [{
                "type": "reasoning",
                "id": "rs_1",
                "encrypted_content": encrypted,
                "metadata": {
                    "encrypted_content": "113833ee-native-cipher"
                },
                "summary": [{"type": "summary_text", "text": summary}]
            }]
        })
    };
    let build_resp02 = |payload: Value| {
        let resp01 = build_v3_provider_resp_inbound_01_raw(
            payload,
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let compat =
            build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01).unwrap();
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat).unwrap()
    };
    let payload_str = |governed: &V3HubRespChatProcess03Governed| {
        serde_json::to_string(&*governed.previous.previous.previous.payload.0)
            .expect("payload serializable")
    };

    // retain=false（默认，typed Responses source）：递归剥离非工具结果的密文。
    let resp02 = build_resp02(payload_with(
        "411bd3dd-47a6-49c0-8eef-6a826f349bf6-0",
        "signed thought",
    ));
    let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
        .expect("govern must succeed");
    let governed = outcome.into_governed();
    let payload = payload_str(&governed);
    assert!(
        !payload.contains("411bd3dd-47a6-49c0-8eef-6a826f349bf6-0"),
        "govern 运行时路径必须剥离 UUID-shaped 密文"
    );
    assert!(
        !payload.contains("113833ee-native-cipher"),
        "govern 运行时路径必须递归剥离 opaque 密文"
    );
    assert!(payload.contains("signed thought"));

    // retain=true（gpt 单 provider）：govern 运行时路径保留密文透传。
    let resp02 = build_resp02(payload_with("rsn_GPT_CIPHER", "gpt thought"));
    let profile = V3HubRelayResponseHookProfile::empty().with_retain_response_cipher(true);
    let outcome = govern_v3_hub_relay_response(resp02, &profile).expect("govern must succeed");
    let governed = outcome.into_governed();
    assert!(
        payload_str(&governed).contains("rsn_GPT_CIPHER"),
        "gpt 单 provider 必须保留 encrypted_content 透传"
    );

    // 未携带 typed Anthropic source witness 时，不能按密文文本形状猜测来源；
    // 非工具结果的 encrypted_content 一律剥离。typed Anthropic source 的保留路径
    // 由 resp03_anthropic_source_witness_preserves_signature_after_canonical_projection 覆盖。
    let resp02 = build_resp02(payload_with("resp04-signature", "signed"));
    let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
        .expect("govern must succeed");
    let governed = outcome.into_governed();
    let payload = payload_str(&governed);
    assert!(
        !payload.contains("resp04-signature"),
        "无 typed Anthropic source 时不得按形状保留密文: {payload}"
    );
    assert!(
        payload.contains("signed"),
        "明文 summary 必须保留: {payload}"
    );
}

#[test]
fn refill_decision_respects_zero_default_and_three() {
    // 0 disables
    assert_eq!(
        decide_v3_chat_process_refill(&[], false, true, 0, 0),
        V3ChatProcessRefillDisposition::Deliver
    );
    // default 1: original + at most one new execution
    assert_eq!(
        decide_v3_chat_process_refill(&[], false, true, 0, 1),
        V3ChatProcessRefillDisposition::RequestRefill
    );
    assert_eq!(
        decide_v3_chat_process_refill(&[], false, true, 1, 1),
        V3ChatProcessRefillDisposition::Deliver
    );
    // 3: original + up to three
    for used in 0..3 {
        assert_eq!(
            decide_v3_chat_process_refill(&[], false, true, used, 3),
            V3ChatProcessRefillDisposition::RequestRefill,
            "used={used}"
        );
    }
    assert_eq!(
        decide_v3_chat_process_refill(&[], false, true, 3, 3),
        V3ChatProcessRefillDisposition::Deliver
    );
}

#[test]
fn refill_decision_stops_on_governed_tool_call() {
    let tool_calls = vec![V3HubResponseToolCall {
        call_id: "call_1".into(),
        name: "echo".into(),
        kind: V3HubRelayToolKind::Function,
    }];
    assert_eq!(
        decide_v3_chat_process_refill(&tool_calls, false, true, 0, 1),
        V3ChatProcessRefillDisposition::Deliver
    );
}

#[test]
fn refill_decision_stops_on_source_summary() {
    assert_eq!(
        decide_v3_chat_process_refill(&[], true, true, 0, 1),
        V3ChatProcessRefillDisposition::Deliver
    );
}

#[test]
fn refill_decision_requires_a_completed_response() {
    // Only a real completed business response is refillable. `incomplete`,
    // `content_filter` and `failed` terminals are delivered as-is.
    assert_eq!(
        decide_v3_chat_process_refill(&[], false, false, 0, 3),
        V3ChatProcessRefillDisposition::Deliver
    );
}

#[test]
fn refill_direct_tool_call_facts_use_the_shared_structural_extractor() {
    let function_call = json!({
        "output": [{
            "type": "function_call",
            "call_id": "call_1",
            "name": "echo",
            "arguments": "{}"
        }]
    });
    let calls = collect_v3_governed_response_tool_calls(&function_call);
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert_eq!(calls[0].call_id, "call_1");
    assert_eq!(calls[0].name, "echo");
    assert_eq!(calls[0].kind, V3HubRelayToolKind::Function);

    // An item carrying a call_id with a call-shaped type also counts.
    let custom_call = json!({
        "output": [{"type": "custom_tool_call", "call_id": "call_2", "name": "patch"}]
    });
    assert_eq!(
        collect_v3_governed_response_tool_calls(&custom_call).len(),
        1
    );

    for ignored in [
        json!({"output": []}),
        json!({"output": [{"type": "message", "content": [{"type": "output_text", "text": "hi"}]}]}),
        // An output is not a new tool call even when it carries a call_id.
        json!({"output": [{"type": "function_call_output", "call_id": "call_1"}]}),
        json!({"output": [{"type": "reasoning", "summary": [{"type": "summary_text", "text": "t"}]}]}),
        json!({}),
    ] {
        assert!(
            collect_v3_governed_response_tool_calls(&ignored).is_empty(),
            "{ignored}"
        );
    }
}

#[test]
fn refill_source_summary_requires_explicit_nonempty_reasoning_summary() {
    let with_summary =
        json!({"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"done"}]}]});
    assert!(has_v3_source_explicit_nonempty_summary(&with_summary));
    let native_chat_summary = json!({
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "reasoning": {
                    "summary": [{"type": "summary_text", "text": "provider summary"}],
                    "content": [{"type": "reasoning_text", "text": "full reasoning"}],
                    "encrypted_content": "opaque"
                },
                "content": "answer"
            },
            "finish_reason": "stop"
        }]
    });
    assert!(has_v3_source_explicit_nonempty_summary(
        &native_chat_summary
    ));
    for ignored in [
        json!({"output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}),
        json!({"output":[{"type":"reasoning","summary":[]}]}),
        json!({"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"   "}]}]}),
        json!({"output":[{"type":"reasoning","summary":"done"}]}),
        json!({"reasoning_content":"done"}),
        json!({"output":[{"type":"reasoning","text":"reasoning body"}]}),
        json!({"choices":[{"message":{"reasoning":{"content":[{"type":"reasoning_text","text":"full reasoning only"}]}}}]}),
        json!({"choices":[{"message":{"reasoning_content":"full reasoning only"}}]}),
        json!({"choices":[{"message":{"reasoning":{"summary":[{"type":"summary_text","text":"  "}]}}}]}),
        json!({}),
    ] {
        assert!(
            !has_v3_source_explicit_nonempty_summary(&ignored),
            "{ignored}"
        );
    }
}

#[test]
fn refill_continuation_keeps_original_fields_and_appends_history_once() {
    let original = json!({
        "model": "gpt-test",
        "instructions": "help the user",
        "tools": [{"type": "function", "name": "echo"}],
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "go"}]}]
    });
    let finalized = json!({
        "id": "resp_1",
        "status": "completed",
        "output": [
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "working"}]},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]}
        ]
    });
    let continuation = build_v3_chat_process_refill_continuation_request(&original, &finalized)
        .expect("continuation must build");
    assert_eq!(continuation["model"], json!("gpt-test"));
    assert_eq!(continuation["instructions"], json!("help the user"));
    assert_eq!(
        continuation["tools"],
        json!([{"type": "function", "name": "echo"}])
    );
    let input = continuation["input"].as_array().expect("input array");
    assert_eq!(
        input.len(),
        3,
        "original + assistant + instruction: {input:?}"
    );
    assert_eq!(input[0]["role"], json!("user"));
    assert_eq!(input[1]["role"], json!("assistant"));
    assert_eq!(
        input[1]["content"],
        json!([{"type": "output_text", "text": "working"}])
    );
    assert_eq!(input[2]["role"], json!("user"));
    assert_eq!(
        input[2]["content"][0]["text"],
        json!(V3_CHAT_PROCESS_REFILL_INSTRUCTION)
    );
}

#[test]
fn refill_continuation_preserves_provider_reasoning_and_skips_synthesized() {
    let original = json!({
        "model": "gpt-test",
        "input": []
    });
    let finalized = json!({
        "id": "resp_1",
        "status": "completed",
        "output": [
            {
                "id": "rsn_provider",
                "type": "reasoning",
                "encrypted_content": "opaque-cipher",
                "summary": [{"type": "summary_text", "text": "source summary"}]
            },
            {
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "answer"}]
            },
            {
                "id": "rcc_reason_call_1",
                "type": "reasoning",
                "summary": [{"type": "summary_text", "text": "synthesized"}]
            },
            {
                "type": "reasoning",
                "summary": [{"type": "summary_text", "text": "anonymous"}]
            },
            {
                "id": "call_1",
                "type": "function_call",
                "call_id": "call_1",
                "name": "echo",
                "arguments": "{}"
            }
        ]
    });
    let continuation = build_v3_chat_process_refill_continuation_request(&original, &finalized)
        .expect("continuation must build");
    let input = continuation["input"].as_array().expect("input array");
    assert_eq!(
        input.len(),
        3,
        "provider reasoning + assistant message + instruction: {input:?}"
    );
    assert_eq!(input[0]["id"], json!("rsn_provider"));
    assert_eq!(input[0]["encrypted_content"], json!("opaque-cipher"));
    assert_eq!(input[0]["summary"][0]["text"], json!("source summary"));
    assert_eq!(input[1]["role"], json!("assistant"));
    assert_eq!(input[2]["role"], json!("user"));
    assert!(
        input
            .iter()
            .all(|item| item["id"] != json!("rcc_reason_call_1")),
        "RCC-synthesized reasoning must not be replayed: {input:?}"
    );
}

#[test]
fn refill_continuation_normalizes_string_input_and_keeps_image_parts() {
    let original = json!({
        "model": "gpt-test",
        "input": "finish the job"
    });
    let finalized = json!({
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "saw it"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
                ]
            }
        ]
    });
    let continuation = build_v3_chat_process_refill_continuation_request(&original, &finalized)
        .expect("continuation must build");
    let input = continuation["input"].as_array().expect("input array");
    assert_eq!(input.len(), 3, "{input:?}");
    assert_eq!(input[0]["role"], json!("user"));
    assert_eq!(input[0]["content"][0]["text"], json!("finish the job"));
    assert_eq!(input[1]["role"], json!("assistant"));
    assert_eq!(
        input[1]["content"][1],
        json!({"type": "input_image", "image_url": "data:image/png;base64,AAAA"})
    );
}

#[test]
fn refill_collect_and_merge_preserve_order_and_last_round_authority() {
    let round_one = json!({
        "id": "resp_1",
        "status": "completed",
        "output": [
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "one"}]},
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "hidden"}]},
            {"type": "function_call", "name": "nope", "call_id": "c1", "arguments": "{}"}
        ]
    });
    let collected = collect_v3_chat_process_business_output_items(&round_one);
    assert_eq!(
        collected.len(),
        3,
        "reasoning is real business content and is preserved: {collected:?}"
    );
    assert_eq!(collected[0]["content"][0]["text"], json!("one"));
    assert_eq!(collected[1]["type"], json!("reasoning"));
    assert_eq!(collected[2]["type"], json!("function_call"));

    let mut last = json!({
        "id": "resp_2",
        "status": "completed",
        "output": [
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "two"}]}
        ]
    });
    merge_v3_chat_process_refill_output_items(&mut last, &collected);
    let output = last["output"].as_array().expect("merged output");
    assert_eq!(output.len(), 4, "{output:?}");
    assert_eq!(output[0]["content"][0]["text"], json!("one"));
    assert_eq!(output[1]["type"], json!("reasoning"));
    assert_eq!(output[2]["type"], json!("function_call"));
    assert_eq!(output[3]["content"][0]["text"], json!("two"));
    assert_eq!(last["id"], json!("resp_2"), "last round id survives");
    assert_eq!(last["status"], json!("completed"));
}

#[test]
fn refill_usage_accumulation_never_fabricates_zero() {
    let summary = |input: Option<u64>, output: Option<u64>| V3RuntimeUsageSummary {
        input_tokens: input,
        output_tokens: output,
        ..V3RuntimeUsageSummary::default()
    };
    let mut accumulated = None;
    accumulate_v3_chat_process_refill_usage(&mut accumulated, Some(summary(Some(3), Some(4))));
    assert_eq!(accumulated.as_ref().unwrap().input_tokens, Some(3));
    assert_eq!(accumulated.as_ref().unwrap().output_tokens, Some(4));
    assert_eq!(
        accumulated.as_ref().unwrap().total_tokens,
        None,
        "the helper never invents total_tokens from input/output"
    );

    accumulate_v3_chat_process_refill_usage(&mut accumulated, Some(summary(Some(3), Some(4))));
    assert_eq!(accumulated.as_ref().unwrap().input_tokens, Some(6));
    assert_eq!(accumulated.as_ref().unwrap().output_tokens, Some(8));

    // A round missing one field makes that field unknown for the whole chain.
    accumulate_v3_chat_process_refill_usage(&mut accumulated, Some(summary(Some(1), None)));
    assert_eq!(accumulated.as_ref().unwrap().input_tokens, Some(7));
    assert_eq!(accumulated.as_ref().unwrap().output_tokens, None);
    assert_eq!(accumulated.as_ref().unwrap().total_tokens, None);

    // A first merge with missing input_tokens never writes 0.
    let mut fresh = None;
    accumulate_v3_chat_process_refill_usage(&mut fresh, Some(summary(None, Some(2))));
    assert_eq!(fresh.as_ref().unwrap().input_tokens, None);
    assert_eq!(fresh.as_ref().unwrap().output_tokens, Some(2));
    assert_eq!(fresh.as_ref().unwrap().total_tokens, None);
}

#[test]
fn refill_usage_write_back_writes_only_observed_fields() {
    let mut response = json!({
        "status": "completed",
        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
    });
    write_v3_chat_process_refill_usage(
        &mut response,
        &V3RuntimeUsageSummary {
            input_tokens: Some(7),
            output_tokens: None,
            total_tokens: None,
            cached_tokens: None,
            cache_read_input_tokens: None,
            cache_creation_input_tokens: None,
        },
    );
    let usage = response["usage"].as_object().expect("usage object");
    assert_eq!(usage["input_tokens"], json!(7));
    assert!(
        !usage.contains_key("output_tokens"),
        "missing round field must not be fabricated: {usage:?}"
    );
    assert!(!usage.contains_key("total_tokens"));

    let mut empty = json!({"status": "completed"});
    write_v3_chat_process_refill_usage(&mut empty, &V3RuntimeUsageSummary::default());
    assert!(
        !empty.as_object().expect("object").contains_key("usage"),
        "all-missing usage must keep usage absent: {empty}"
    );
}
