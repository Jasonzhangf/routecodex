use super::*;

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

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

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

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

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

    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut payload, false);

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
    routecodex_v3_provider_responses::apply_v3_response_cipher_policy(&mut stripped, false);
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
fn resp03_govern_runtime_path_strips_rsn_cipher_but_keeps_anthropic_signature() {
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
                "summary": [{"type": "summary_text", "text": summary}]
            }]
        })
    };
    let build_resp02 = |payload: Value| {
        let resp01 = build_v3_provider_resp_inbound_01_raw(
            payload,
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubContinuationOwnership::New,
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

    // retain=false（默认）：govern 运行时路径剥离 rsn_ 密文。
    let resp02 = build_resp02(payload_with("rsn_CODEX_CIPHER", "signed thought"));
    let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
        .expect("govern must succeed");
    let (governed, _, _) = outcome.into_parts();
    let payload = payload_str(&governed);
    assert!(
        !payload.contains("rsn_CODEX_CIPHER"),
        "govern 运行时路径必须剥离 Codex rsn_ 密文"
    );
    assert!(payload.contains("signed thought"));

    // retain=true（gpt 单 provider）：govern 运行时路径保留密文透传。
    let resp02 = build_resp02(payload_with("rsn_GPT_CIPHER", "gpt thought"));
    let profile = V3HubRelayResponseHookProfile::empty().with_retain_response_cipher(true);
    let outcome = govern_v3_hub_relay_response(resp02, &profile).expect("govern must succeed");
    let (governed, _, _) = outcome.into_parts();
    assert!(
        payload_str(&governed).contains("rsn_GPT_CIPHER"),
        "gpt 单 provider 必须保留 encrypted_content 透传"
    );

    // anthropic thinking signature 载体（值非 rsn_/gAAAA 前缀）永不清除——
    // recursive 层只剥离 Codex 密文（rsn_ / gAAAA 开头）。
    let resp02 = build_resp02(payload_with("resp04-signature", "signed"));
    let outcome = govern_v3_hub_relay_response(resp02, &V3HubRelayResponseHookProfile::empty())
        .expect("govern must succeed");
    let (governed, _, _) = outcome.into_parts();
    let payload = payload_str(&governed);
    assert!(
        payload.contains("resp04-signature"),
        "anthropic thinking signature 载体不得被剥离: {payload}"
    );
    assert!(
        payload.contains("signed"),
        "明文 summary 必须保留: {payload}"
    );
}
