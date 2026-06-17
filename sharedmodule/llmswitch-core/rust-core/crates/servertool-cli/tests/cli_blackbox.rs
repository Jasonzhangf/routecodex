use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_routecodex-servertool")
}

fn unique_identity(prefix: &str) -> (String, String) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();
    (
        format!("{prefix}-session-{pid}-{millis}"),
        format!("{prefix}-request-{pid}-{millis}"),
    )
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
        "\"restorationHandle\"",
        "\"restorationStore\"",
        "reenterPipeline",
        "providerInvoker",
        "serverToolFollowup",
        "serverToolFollowupSource",
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
            r#"{"flowId":"stop_message_flow","continuationPrompt":"继续做下一步","repeatCount":1,"maxRepeats":3}"#,
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
    let prompt = value["continuationPrompt"].as_str().expect("continuation prompt");
    assert!(!prompt.is_empty());
    for forbidden in [
        "schema",
        "hook",
        "stopless",
        "servertool",
        "第一轮",
        "第二轮",
        "第三轮",
        "必须调用",
        "证据不足",
        "用户目标",
        "已排除因素",
        "排查顺序",
    ] {
        assert!(
            !prompt.contains(forbidden),
            "prompt must not contain forbidden token {forbidden}: {prompt}"
        );
    }
    assert!(value.get("schemaGuidance").is_some());
    assert_eq!(value["schemaGuidance"]["stopreasonValues"]["finished"], 0);
    assert_eq!(value["schemaGuidance"]["stopreasonValues"]["blocked"], 1);
    assert_eq!(value["schemaGuidance"]["stopreasonValues"]["continueNeeded"], 2);
    assert!(value["schemaGuidance"]["requiredFields"]
        .as_array()
        .expect("required fields")
        .iter()
        .any(|field| field.as_str() == Some("stopreason")));
    assert!(value.get("injectedPromptPreview").is_none());
    assert!(value["input"].get("continuationPrompt").is_none());
    assert!(value["input"].get("schemaGuidance").is_none());
    assert_no_internal_or_restoration_carrier(&value);
}

#[test]
fn stop_message_auto_explicit_repeat_args_override_input_json() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--repeat-count",
            "2",
            "--max-repeats",
            "5",
            "--input-json",
            r#"{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(value["repeatCount"], 3);
    assert_eq!(value["maxRepeats"], 5);
    assert_eq!(value["input"]["repeatCount"], 3);
    assert_eq!(value["input"]["maxRepeats"], 5);
    assert_no_internal_or_restoration_carrier(&value);
}

#[test]
fn missing_continuation_prompt_still_succeeds_status_only() {
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
    assert!(output.status.success(), "stderr={}", String::from_utf8_lossy(&output.stderr));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(value["toolName"], "stop_message_auto");
    assert_eq!(value["flowId"], "stop_message_flow");
    let prompt = value["continuationPrompt"].as_str().expect("continuation prompt");
    assert!(!prompt.is_empty());
    assert!(value["input"].get("continuationPrompt").is_none());
    assert!(value["input"].get("schemaGuidance").is_none());
    for forbidden in [
        "schema",
        "hook",
        "stopless",
        "servertool",
        "第一轮",
        "第二轮",
        "第三轮",
        "必须调用",
        "证据不足",
        "用户目标",
        "已排除因素",
        "排查顺序",
    ] {
        assert!(
            !prompt.contains(forbidden),
            "prompt must not contain forbidden token {forbidden}: {prompt}"
        );
    }
    assert_no_internal_or_restoration_carrier(&value);
}

#[test]
fn missing_session_identity_is_allowed() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--input-json",
            r#"{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(value["repeatCount"], 2);
    assert!(value.get("sessionId").is_none());
    assert!(value.get("requestId").is_none());
}

#[test]
fn stopless_repeat_count_depends_only_on_current_input() {
    let first = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--input-json",
            r#"{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(first.status.success(), "stderr={}", String::from_utf8_lossy(&first.stderr));
    let first_value: serde_json::Value =
        serde_json::from_slice(&first.stdout).expect("json stdout");
    assert_eq!(first_value["repeatCount"], 2);

    let second = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--input-json",
            r#"{"flowId":"stop_message_flow","repeatCount":2,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(second.status.success(), "stderr={}", String::from_utf8_lossy(&second.stderr));
    let second_value: serde_json::Value =
        serde_json::from_slice(&second.stdout).expect("json stdout");
    assert_eq!(second_value["repeatCount"], 3);
}

#[test]
fn exhausted_stopless_run_stays_terminal_for_current_input() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--input-json",
            r#"{"flowId":"stop_message_flow","repeatCount":3,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(
        output.status.success(),
        "step=5 stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(
        value["summary"], "stopless budget exhausted",
        "exhausted stopless input must stay terminal closed; got: {}",
        value
    );
    assert_eq!(
        value["repeatCount"], 3,
        "exhausted stopless input must not reset repeatCount; got: {}",
        value
    );
    assert_eq!(
        value["input"]["repeatCount"], 3,
        "exhausted stopless input must keep repeatCount=3; got: {}",
        value
    );
}

#[test]
fn invalid_stop_message_flow_id_fails_fast() {
    let (session_id, request_id) = unique_identity("invalid-flow");
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--session-id",
            &session_id,
            "--request-id",
            &request_id,
            "--flow",
            "not_stop_message_flow",
            "--input-json",
            r#"{"repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SERVERTOOL_CLI_INVALID_FIELD: flowId"));
}

#[test]
fn explicit_flow_arg_overrides_input_json_flow_id() {
    let (session_id, request_id) = unique_identity("flow-override");
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--session-id",
            &session_id,
            "--request-id",
            &request_id,
            "--flow",
            "stop_message_flow",
            "--input-json",
            r#"{"flowId":"wrong_flow","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(value["flowId"], "stop_message_flow");
    assert_eq!(value["input"]["flowId"], "stop_message_flow");
    assert_no_internal_or_restoration_carrier(&value);
}

#[test]
fn exhausted_stop_message_repeat_budget_returns_terminal_summary() {
    for input_json in [
        r#"{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":0}"#,
        r#"{"flowId":"stop_message_flow","repeatCount":4,"maxRepeats":3}"#,
    ] {
        let (session_id, request_id) = unique_identity("invalid-budget");
        let output = Command::new(bin())
            .args([
                "run",
                "stop_message_auto",
                "--session-id",
                &session_id,
                "--request-id",
                &request_id,
                "--input-json",
                input_json,
            ])
            .output()
            .expect("run routecodex-servertool");
        assert!(output.status.success(), "stderr={}", String::from_utf8_lossy(&output.stderr));
        let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
        assert_eq!(value["summary"], "stopless budget exhausted");
        assert_eq!(value["repeatCount"], value["maxRepeats"]);
        assert_no_internal_or_restoration_carrier(&value);
    }
}

#[test]
fn exhausted_explicit_repeat_args_return_terminal_summary() {
    let (session_id, request_id) = unique_identity("invalid-explicit");
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--session-id",
            &session_id,
            "--request-id",
            &request_id,
            "--repeat-count",
            "4",
            "--max-repeats",
            "3",
            "--input-json",
            r#"{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(output.status.success(), "stderr={}", String::from_utf8_lossy(&output.stderr));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json stdout");
    assert_eq!(value["summary"], "stopless budget exhausted");
    assert_eq!(value["repeatCount"], 3);
    assert_eq!(value["maxRepeats"], 3);
    assert_no_internal_or_restoration_carrier(&value);
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
        assert!(
            output.stdout.is_empty(),
            "{tool_name} failure must not emit client-visible stdout: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&format!("SERVERTOOL_UNSUPPORTED_TOOL: {tool_name}")),
            "stderr={stderr}"
        );
    }
}

#[test]
fn unknown_tool_fails_fast_without_client_stdout() {
    let output = Command::new(bin())
        .args([
            "run",
            "unknown_servertool",
            "--input-json",
            r#"{"value":1}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "unknown tool failure must not emit client-visible stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("SERVERTOOL_UNSUPPORTED_TOOL: unknown_servertool"),
        "stderr={stderr}"
    );
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
fn malformed_input_json_fails_fast() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--input-json",
            r#"{"bad":"json""#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("SERVERTOOL_CLI_INVALID_JSON:"),
        "stderr={stderr}"
    );
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

#[test]
fn private_carrier_text_fails_fast() {
    let output = Command::new(bin())
        .args([
            "run",
            "servertool_fixture",
            "--input-json",
            r#"{"value":"serverToolFollowup must not be restored"}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "private carrier text failure must not emit client-visible stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("SERVERTOOL_DENIED_INTERNAL_CARRIER: serverToolFollowup"),
        "stderr={stderr}"
    );
}

#[test]
fn restoration_handle_carrier_fails_fast() {
    for (input_json, carrier) in [
        (
            r#"{"restorationHandle":"legacy_handle"}"#,
            "restorationHandle",
        ),
        (
            r#"{"restorationStore":{"id":"legacy_store"}}"#,
            "restorationStore",
        ),
    ] {
        let output = Command::new(bin())
            .args(["run", "servertool_fixture", "--input-json", input_json])
            .output()
            .expect("run routecodex-servertool");
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains(&format!("SERVERTOOL_DENIED_INTERNAL_CARRIER: {carrier}")),
            "stderr={stderr}"
        );
        assert!(output.stdout.is_empty());
    }
}
