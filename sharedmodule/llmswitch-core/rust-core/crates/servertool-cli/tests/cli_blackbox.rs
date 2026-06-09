use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_routecodex-servertool")
}

fn assert_no_internal_or_restoration_carrier(value: &serde_json::Value) {
    let raw = serde_json::to_string(value).expect("serialize cli stdout");
    for forbidden in [
        "\"metadata\"",
        "\"__rt\"",
        "\"snapshot\"",
        "\"debug\"",
        "\"debugCarrier\"",
        "\"ticket\"",
        "--ticket",
        "stcli_",
        "rcc_cli_",
        "old_cli_",
        "old_cli_result_",
    ] {
        assert!(
            !raw.contains(forbidden),
            "servertool stdout must not contain forbidden carrier/marker {forbidden}: {raw}"
        );
    }
}

#[test]
fn stop_message_auto_outputs_rust_owned_schema() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--input-json",
            r#"{"flowId":"stop_message_flow","continuationPrompt":"continue with schema","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(value["toolName"], "stop_message_auto");
    assert_eq!(value["ok"], true);
    assert_eq!(value["kind"], "stop_message_auto");
    assert_eq!(value["tool"], "stop_message_auto");
    assert_eq!(value["flowId"], "stop_message_flow");
    assert_eq!(value["summary"], "stopless continuation ready");
    assert_eq!(
        value["schemaGuidance"]["stopreasonValues"]["continueNeeded"],
        2
    );
    assert_eq!(value["injectedPromptPreview"], "continue with schema");
    assert_no_internal_or_restoration_carrier(&value);
}

#[test]
fn missing_continuation_prompt_fails_fast() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--flow",
            "stop_message_flow",
            "--input-json",
            r#"{"repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SERVERTOOL_CLI_MISSING_FIELD: continuationPrompt"));
}

#[test]
fn invalid_stop_message_flow_id_fails_fast() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--flow",
            "not_stop_message_flow",
            "--input-json",
            r#"{"continuationPrompt":"continue","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SERVERTOOL_CLI_INVALID_FIELD: flowId"));
}

#[test]
fn invalid_stop_message_repeat_budget_fails_fast() {
    for input_json in [
        r#"{"flowId":"stop_message_flow","continuationPrompt":"continue","repeatCount":1,"maxRepeats":0}"#,
        r#"{"flowId":"stop_message_flow","continuationPrompt":"continue","repeatCount":4,"maxRepeats":3}"#,
    ] {
        let output = Command::new(bin())
            .args(["run", "stop_message_auto", "--input-json", input_json])
            .output()
            .expect("run routecodex-servertool");
        assert!(
            !output.status.success(),
            "{input_json} must fail-fast"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("SERVERTOOL_CLI_INVALID_FIELD: repeatCount/maxRepeats"),
            "stderr={stderr}"
        );
    }
}

#[test]
fn non_client_exec_servertools_fail_fast() {
    for tool_name in ["web_search", "vision_auto", "memory_cache_auto"] {
        let output = Command::new(bin())
            .args([
                "run",
                tool_name,
                "--input-json",
                r#"{"query":"x","image":"data"}"#,
            ])
            .output()
            .expect("run routecodex-servertool");
        assert!(
            !output.status.success(),
            "{tool_name} must not be executable through client CLI stdout"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&format!("SERVERTOOL_UNSUPPORTED_TOOL: {tool_name}")),
            "stderr={stderr}"
        );
    }
}

#[test]
fn servertool_fixture_outputs_ordinary_exec_command_json() {
    let output = Command::new(bin())
        .args([
            "run",
            "servertool_fixture",
            "--input-json",
            r#"{"value":1}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(value["ok"], true);
    assert_eq!(value["kind"], "servertool_fixture");
    assert_eq!(value["tool"], "servertool_fixture");
    assert_eq!(value["toolName"], "servertool_fixture");
    assert_eq!(value["flowId"], "servertool_cli_projection");
    assert_eq!(value["input"], serde_json::json!({"value":1}));
    assert!(value.get("schemaGuidance").is_none());
    assert_no_internal_or_restoration_carrier(&value);
}

#[test]
fn non_object_input_json_fails_fast() {
    let output = Command::new(bin())
        .args(["run", "stop_message_auto", "--input-json", r#"["bad"]"#])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SERVERTOOL_CLI_INVALID_FIELD: inputJson"));
}

#[test]
fn fake_exec_tool_name_fails_fast() {
    let output = Command::new(bin())
        .args(["run", "fake_exec", "--input-json", r#"{"value":1}"#])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SERVERTOOL_DENIED_TOOL: fake_exec"));
}

#[test]
fn denied_cli_markers_fail_fast() {
    for (raw_value, expected_marker) in [
        ("--ticket abc", "--ticket"),
        ("stcli_123", "stcli_"),
        ("rcc_cli_123", "rcc_cli_"),
        ("old_cli_123", "old_cli_"),
        ("old_cli_result_123", "old_cli_"),
    ] {
        let input = format!(r#"{{"value":"{raw_value}"}}"#);
        let output = Command::new(bin())
            .args(["run", "servertool_fixture", "--input-json", &input])
            .output()
            .expect("run routecodex-servertool");
        assert!(!output.status.success(), "{raw_value} must fail-fast");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&format!("SERVERTOOL_DENIED_CLI_MARKER: {expected_marker}")),
            "stderr={stderr}"
        );
    }
}

#[test]
fn denied_cli_markers_in_tool_name_and_flow_fail_fast() {
    let tool_name_output = Command::new(bin())
        .args(["run", "old_cli_123", "--input-json", r#"{"value":1}"#])
        .output()
        .expect("run routecodex-servertool");
    assert!(!tool_name_output.status.success());
    let stderr = String::from_utf8_lossy(&tool_name_output.stderr);
    assert!(
        stderr.contains("SERVERTOOL_DENIED_CLI_MARKER: old_cli_"),
        "stderr={stderr}"
    );

    let flow_output = Command::new(bin())
        .args([
            "run",
            "servertool_fixture",
            "--flow",
            "stcli_123",
            "--input-json",
            r#"{"value":1}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!flow_output.status.success());
    let stderr = String::from_utf8_lossy(&flow_output.stderr);
    assert!(
        stderr.contains("SERVERTOOL_DENIED_CLI_MARKER: stcli_"),
        "stderr={stderr}"
    );
}

#[test]
fn internal_carrier_fails_fast() {
    let output = Command::new(bin())
        .args([
            "run",
            "servertool_fixture",
            "--input-json",
            r#"{"metadata":{"requestId":"req_internal"}}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SERVERTOOL_DENIED_INTERNAL_CARRIER: metadata"));
}
