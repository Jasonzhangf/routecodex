use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_routecodex-servertool")
}

#[test]
fn stop_message_auto_outputs_rust_owned_schema() {
    let output = Command::new(bin())
        .args([
            "run",
            "stop_message_auto",
            "--flow",
            "stop_message_flow",
            "--input-json",
            r#"{"continuationPrompt":"continue with schema","repeatCount":1,"maxRepeats":3}"#,
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
    assert_eq!(value["flowId"], "stop_message_flow");
    assert_eq!(value["schemaGuidance"]["stopreasonValues"]["continueNeeded"], 2);
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
fn web_search_is_not_client_exec_cli_projection() {
    let output = Command::new(bin())
        .args([
            "run",
            "web_search",
            "--flow",
            "stop_message_flow",
            "--input-json",
            r#"{"continuationPrompt":"continue with schema","repeatCount":1,"maxRepeats":3}"#,
        ])
        .output()
        .expect("run routecodex-servertool");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SERVERTOOL_UNSUPPORTED_TOOL: web_search"));
}
