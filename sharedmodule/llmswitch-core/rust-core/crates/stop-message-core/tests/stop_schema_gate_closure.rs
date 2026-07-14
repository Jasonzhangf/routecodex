//! Stop-schema gate closure — Unit tests (RED baseline)
//!
//! 测试目标：
//! 1. reasoning.stop.arguments 带完整 stopreason=0 → AllowStop
//! 2. `<rcc_stop_schema>` 带完整 stopreason=1 → AllowStop
//! 3. `<rcc_stop_schema>` 带完整 stopreason=2 + next_step → Followup
//! 4. 无 schema → Followup + 字段提示
//! 5. 连续 3 次无 schema → AllowStop passthrough，不投影第 4 次 CLI
//! 6. fence 内非法 JSON → invalid_json
//! 7. forcestop=1 → AllowStop bypass budget
//! 8. needs_user_input=true → AllowStop
//! 9. 不同错误类型 → no_change_count 重置

use stop_message_core::{
    evaluate_stop_schema_gate, evaluate_stop_schema_gate_with_reasoning_stop_arguments,
    StopSchemaGateAction,
};

// ── T1: 完整 schema → AllowStop ─────────────────────────────────────────────

#[test]
fn t1_finished_schema_allows_stop() {
    let input = r#"{"stopreason":0,"reason":"审计完成","has_evidence":1,"evidence":"docs落地","issue_cause":"问题已定位","excluded_factors":"无","diagnostic_order":"文档→代码","done_steps":"审计报告写入","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"useEffect风暴主因"}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(input), 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d.reason_code, "stop_schema_finished");
    assert!(!d.count_budget);
}

#[test]
fn t1_blocked_schema_allows_stop() {
    let input = r#"<rcc_stop_schema>
{"stopreason":1,"reason":"缺文件","has_evidence":1,"evidence":"git log","issue_cause":"文件未提交","excluded_factors":"非代码问题","diagnostic_order":"git→文件系统","done_steps":"定位文件","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"确认工作目录"}
</rcc_stop_schema>"#;
    let d = evaluate_stop_schema_gate(input, 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d.reason_code, "stop_schema_blocked");
    assert!(!d.count_budget);
}

#[test]
fn t1_continue_with_next_step_follows_up() {
    let input = r#"<rcc_stop_schema>
{"stopreason":2,"reason":"需验证","current_goal":"完成 stop schema gate 验证","has_evidence":0,"evidence":"","issue_cause":"","excluded_factors":"","diagnostic_order":"","done_steps":"","next_step":"运行 cargo test 验证修复","next_suggested_path":"","needs_user_input":false,"learned":""}
</rcc_stop_schema>"#;
    let d = evaluate_stop_schema_gate(input, 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::Followup);
    assert_eq!(d.reason_code, "stop_schema_continue_next_step");
    assert_eq!(d.missing_fields, Vec::<String>::new());
    assert_eq!(d.followup_text.as_deref(), Some("运行 cargo test 验证修复"));
    assert!(!d.count_budget);
}

#[test]
fn t1_continue_with_json_code_fence_follows_up() {
    let input = r#"继续执行。
```json
{"stopreason":2,"reason":"需验证","current_goal":"完成 stop schema gate 验证","has_evidence":0,"evidence":"","issue_cause":"","excluded_factors":"","diagnostic_order":"","done_steps":"","next_step":"运行 cargo test 验证修复","next_suggested_path":"","needs_user_input":false,"learned":""}
```"#;
    let d = evaluate_stop_schema_gate(input, 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::Followup);
    assert_eq!(d.reason_code, "stop_schema_continue_next_step");
    assert!(!d.count_budget);
}

// ── T2: 缺失 schema → Followup + 字段提示 ───────────────────────────────────

#[test]
fn t2_no_schema_returns_followup() {
    let d = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::Followup);
    assert_eq!(d.reason_code, "stop_schema_missing");
    assert!(d.count_budget);
    assert_eq!(d.no_change_count, 1);
    let text = d.followup_text.as_deref().unwrap_or("");
    assert!(
        text.contains("stopreason"),
        "must mention stopreason, got: {text}"
    );
    assert!(text.contains("reason"), "must mention reason, got: {text}");
    assert!(
        text.contains("evidence"),
        "must mention evidence, got: {text}"
    );
}

#[test]
fn t2_no_schema_repeated_three_times_allows_original_stop_passthrough() {
    let d1 = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
    assert_eq!(d1.reason_code, "stop_schema_missing");
    assert_eq!(d1.action, StopSchemaGateAction::Followup);
    assert_eq!(d1.no_change_count, 1);

    let d2 = evaluate_stop_schema_gate(
        "普通停止文本",
        1,
        3,
        d1.observation_hash.as_str(),
        d1.no_change_count,
    );
    assert_eq!(d2.action, StopSchemaGateAction::Followup);
    assert_eq!(d2.no_change_count, 2);
    assert_eq!(d2.reason_code, "stop_schema_missing");

    let d3 = evaluate_stop_schema_gate(
        "普通停止文本",
        2,
        3,
        d2.observation_hash.as_str(),
        d2.no_change_count,
    );
    assert_eq!(d3.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d3.reason_code, "stop_schema_loop_guard_passthrough");
    assert_eq!(d3.no_change_count, 3);
}

#[test]
fn t2_missing_stopreason_returns_followup() {
    let input = r#"<rcc_stop_schema>
{"reason":"完成","has_evidence":1,"evidence":"通过"}
</rcc_stop_schema>"#;
    let d = evaluate_stop_schema_gate(input, 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::Followup);
    assert!(d.missing_fields.contains(&"stopreason".to_string()));
}

#[test]
fn t2_stopreason_non_numeric_returns_followup() {
    let input = r#"<rcc_stop_schema>
{"stopreason":"finished","reason":"完成"}
</rcc_stop_schema>"#;
    let d = evaluate_stop_schema_gate(input, 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::Followup);
    assert_eq!(
        d.reason_code,
        "stop_schema_stopreason_missing_or_non_numeric"
    );
}

// ── T3: 连续 3 次 → passthrough 原始 stop ───────────────────────────────────

#[test]
fn t3_third_no_schema_allows_original_stop_passthrough() {
    let d1 = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
    assert_eq!(d1.action, StopSchemaGateAction::Followup);
    assert_eq!(d1.no_change_count, 1);

    let d2 = evaluate_stop_schema_gate(
        "普通停止文本",
        1,
        3,
        &d1.observation_hash,
        d1.no_change_count,
    );
    assert_eq!(d2.action, StopSchemaGateAction::Followup);
    assert_eq!(d2.no_change_count, 2);

    let d3 = evaluate_stop_schema_gate(
        "普通停止文本",
        2,
        3,
        &d2.observation_hash,
        d2.no_change_count,
    );
    assert_eq!(
        d3.action,
        StopSchemaGateAction::AllowStop,
        "3rd consecutive missing schema must pass the original stop through"
    );
    assert_eq!(d3.reason_code, "stop_schema_loop_guard_passthrough");
    assert!(d3.followup_text.is_none());
}

#[test]
fn t3_third_invalid_schema_allows_original_stop_passthrough() {
    let bad = "<rcc_stop_schema>{bad json}</rcc_stop_schema>";
    let d1 = evaluate_stop_schema_gate(bad, 0, 3, "", 0);
    assert_eq!(d1.action, StopSchemaGateAction::Followup);
    assert_eq!(d1.reason_code, "stop_schema_invalid_json");

    let d2 = evaluate_stop_schema_gate(bad, 1, 3, &d1.observation_hash, d1.no_change_count);
    assert_eq!(d2.action, StopSchemaGateAction::Followup);

    let d3 = evaluate_stop_schema_gate(bad, 2, 3, &d2.observation_hash, d2.no_change_count);
    assert_eq!(d3.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d3.reason_code, "stop_schema_loop_guard_passthrough");
}

#[test]
fn t3_unclosed_json_fence_is_invalid_json_not_missing() {
    let bad = "```json\n{\"stopreason\":2,\"reason\":\"still running\"}";
    let decision = evaluate_stop_schema_gate(bad, 0, 3, "", 0);
    assert_eq!(decision.action, StopSchemaGateAction::Followup);
    assert_eq!(decision.reason_code, "stop_schema_invalid_json");
}

#[test]
fn t3_bare_json_in_assistant_text_is_accepted_as_terminal_schema() {
    let bare = r#"{"stopreason":0,"reason":"done","has_evidence":1,"evidence":"ok","issue_cause":"none","excluded_factors":"none","diagnostic_order":"1","done_steps":"done","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"ok"}"#;
    let decision = evaluate_stop_schema_gate(bare, 0, 3, "", 0);
    assert_eq!(decision.action, StopSchemaGateAction::AllowStop);
    assert_eq!(decision.reason_code, "stop_schema_finished");
}

#[test]
fn t3_invalid_schema_with_empty_arguments_fails_fast_after_three_rounds() {
    let d1 =
        evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(r#"{}"#), 0, 3, "", 0);
    assert_eq!(d1.action, StopSchemaGateAction::Followup);
    assert_eq!(
        d1.reason_code,
        "stop_schema_stopreason_missing_or_non_numeric"
    );

    let d2 = evaluate_stop_schema_gate_with_reasoning_stop_arguments(
        "",
        Some(r#"{}"#),
        1,
        3,
        &d1.observation_hash,
        d1.no_change_count,
    );
    assert_eq!(d2.action, StopSchemaGateAction::Followup);
    assert_eq!(d2.no_change_count, 2);

    let d3 = evaluate_stop_schema_gate_with_reasoning_stop_arguments(
        "",
        Some(r#"{}"#),
        2,
        3,
        &d2.observation_hash,
        d2.no_change_count,
    );
    assert_eq!(d3.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d3.reason_code, "stop_schema_loop_guard_passthrough");
}

// ── T4: 不同错误 → no_change_count 重置 ─────────────────────────────────────

#[test]
fn t4_different_error_resets_no_change_count() {
    let d1 = evaluate_stop_schema_gate("文本A", 0, 3, "", 0);
    assert_eq!(d1.no_change_count, 1);
    let d2 = evaluate_stop_schema_gate(
        "<rcc_stop_schema>{bad json}</rcc_stop_schema>",
        0,
        3,
        &d1.observation_hash,
        d1.no_change_count,
    );
    // 不同 observation hash → count 重置为 1
    assert_eq!(
        d2.no_change_count, 1,
        "different error must reset no_change_count"
    );
}

#[test]
fn t4_same_error_same_hash_keeps_counter_but_different_reason_resets() {
    let missing = evaluate_stop_schema_gate("普通停止文本", 0, 3, "", 0);
    let repeated_missing = evaluate_stop_schema_gate(
        "另一个文本但同样没 schema",
        0,
        3,
        &missing.observation_hash,
        missing.no_change_count,
    );
    assert_eq!(repeated_missing.no_change_count, 2);

    let invalid =
        evaluate_stop_schema_gate("<rcc_stop_schema>{bad json}</rcc_stop_schema>", 0, 3, "", 0);
    assert_ne!(missing.observation_hash, invalid.observation_hash);
    assert_eq!(
        evaluate_stop_schema_gate(
            "<rcc_stop_schema>\n{\"reason\":\"done\"}\n</rcc_stop_schema>",
            0,
            3,
            &invalid.observation_hash,
            invalid.no_change_count,
        )
        .no_change_count,
        1
    );
}

// ── T5: forcestop bypass ────────────────────────────────────────────────────

#[test]
fn t5_forcestop_bypasses_budget() {
    let input = r#"{"forcestop":1,"reason":"必须强制停止"}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(input), 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d.reason_code, "stop_schema_forcestop");
    assert!(!d.count_budget);
}

// ── T6: needs_user_input → AllowStop ────────────────────────────────────────

#[test]
fn t6_needs_user_input_with_next_step_allows_stop() {
    let input = r#"{"stopreason":2,"reason":"需确认","has_evidence":0,"next_step":"请确认：使用哪个版本？","needs_user_input":true}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(input), 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d.reason_code, "stop_schema_needs_user_input");
    let summary = d.summary_prefix.as_deref().unwrap_or("");
    assert!(summary.contains("需确认"), "summary={summary}");
    assert!(summary.contains("需要你决定"), "summary={summary}");
    assert!(
        summary.contains("请确认：使用哪个版本？"),
        "summary={summary}"
    );
    assert!(!d.count_budget);
}

#[test]
fn t6_needs_user_input_without_next_step_reports_only_next_step() {
    let input = r#"{"stopreason":1,"reason":"缺少用户决策","has_evidence":1,"evidence":"已有两条可选路径","needs_user_input":true}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(input), 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::Followup);
    assert_eq!(
        d.reason_code,
        "stop_schema_needs_user_input_missing_next_step"
    );
    assert_eq!(d.missing_fields, vec!["next_step".to_string()]);
}

#[test]
fn t6_continue_with_has_evidence_one_keeps_current_goal_next_step_feedback() {
    let input = r#"{"stopreason":2,"reason":"继续验证","current_goal":"完成 stop schema gate 验证","has_evidence":1,"next_step":"运行下一条验证命令","needs_user_input":false}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(input), 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::Followup);
    assert_eq!(d.reason_code, "stop_schema_continue_next_step");
    assert_eq!(d.missing_fields, Vec::<String>::new());
    assert!(!d.count_budget);
}

#[test]
fn t6_finished_minimal_terminal_schema_allows_without_diagnostic_fields() {
    let input = r#"{"stopreason":0,"reason":"已完成","has_evidence":1,"evidence":"cargo test passed","needs_user_input":false}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(input), 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d.reason_code, "stop_schema_finished");
    assert_eq!(d.missing_fields, Vec::<String>::new());
}

#[test]
fn t6_terminal_without_evidence_reports_only_evidence_contract_fields() {
    let input =
        r#"{"stopreason":1,"reason":"被外部凭证阻塞","has_evidence":0,"needs_user_input":false}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(input), 0, 3, "", 0);
    assert_eq!(d.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d.reason_code, "stop_schema_blocked");
    assert!(d.missing_fields.is_empty());
    assert!(!d.count_budget);
}

#[test]
fn t6_complete_schema_keeps_finalized_reason_code_and_clears_counter() {
    let input = r#"{"stopreason":0,"reason":"已完成并验证","has_evidence":1,"evidence":"cargo test pass","issue_cause":"无","excluded_factors":"无","diagnostic_order":"1.定位 2.修复 3.验证","done_steps":"补测试并验证","next_step":"","next_suggested_path":"","needs_user_input":false,"learned":"schema complete"}"#;
    let d = evaluate_stop_schema_gate_with_reasoning_stop_arguments(
        "",
        Some(input),
        2,
        3,
        "stale-hash",
        2,
    );
    assert_eq!(d.action, StopSchemaGateAction::AllowStop);
    assert_eq!(d.reason_code, "stop_schema_finished");
    assert_eq!(d.no_change_count, 0);
    assert!(d.observation_hash.is_empty());
}
