use routecodex_v4_cordis_bridge::{
    execute_plan, NodeExecutionInput, ScopeSessionCommand, ScopeSessionOperation,
};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn metadata_control() -> Value {
    json!({
        "metadata_center": {
            "continuation": {
                "entry_protocol": "responses",
                "continuation_owner": "direct",
                "pipeline_id": "pipeline-1",
                "port": 5555,
                "session_scope": "session-1",
                "conversation_scope": "conversation-1",
                "request_id": "response-1",
                "full_input_hash": "sha256:full-input",
                "sequence": 7
            }
        }
    })
}

#[test]
fn continuation_commit_reads_typed_control_and_preserves_response_data() {
    let plan = compile_standard_plan(
        "V4HubRespChatProcess03Governed",
        "response_chat_process",
        "response",
        3,
        &["v4.std.continuation.commit"],
    )
    .expect("commit plan compiles");
    let data = json!({"text": "same-shape"});
    let output = execute_plan(
        &plan,
        NodeExecutionInput {
            data: data.clone(),
            control: metadata_control(),
        },
        &StandardHandleRegistry::new(),
    )
    .expect("typed continuation commit executes");

    assert_eq!(output.data, data);
    let scope = ScopeSessionCommand::parse(
        output
            .control
            .get("scope_command")
            .expect("scope session slot written"),
    )
    .expect("bridge slot is typed");
    assert_eq!(scope.operation, ScopeSessionOperation::Bind);
    assert_eq!(scope.sequence, 7);
}

#[test]
fn continuation_release_reads_typed_control_and_writes_only_scope_slot() {
    let plan = compile_standard_plan(
        "V4HubRespChatProcess03Governed",
        "response_chat_process",
        "response",
        3,
        &["v4.std.continuation.release"],
    )
    .expect("release plan compiles");
    let output = execute_plan(
        &plan,
        NodeExecutionInput {
            data: json!({"text": "same-shape"}),
            control: metadata_control(),
        },
        &StandardHandleRegistry::new(),
    )
    .expect("typed continuation release executes");

    let scope = ScopeSessionCommand::parse(
        output
            .control
            .get("scope_command")
            .expect("scope session slot written"),
    )
    .expect("bridge slot is typed");
    assert_eq!(scope.operation, ScopeSessionOperation::Release);
}

#[test]
fn payload_lookalike_without_metadata_control_fails_fast() {
    let plan = compile_standard_plan(
        "V4HubRespChatProcess03Governed",
        "response_chat_process",
        "response",
        3,
        &["v4.std.continuation.commit"],
    )
    .expect("commit plan compiles");
    let error = execute_plan(
        &plan,
        NodeExecutionInput {
            data: json!({
                "continuation": {
                    "entry_protocol": "responses",
                    "continuation_owner": "direct",
                    "port": 5555,
                    "session_scope": "session-1",
                    "conversation_scope": "conversation-1",
                    "request_id": "response-1",
                    "full_input_hash": "sha256:payload-lookalike"
                }
            }),
            control: json!({}),
        },
        &StandardHandleRegistry::new(),
    )
    .expect_err("payload lookalike must not reconstruct continuation control");
    assert!(error.to_string().contains("metadata_center"));
}

#[test]
fn malformed_typed_control_fails_fast_without_scope_slot() {
    let plan = compile_standard_plan(
        "V4HubRespChatProcess03Governed",
        "response_chat_process",
        "response",
        3,
        &["v4.std.continuation.commit"],
    )
    .expect("commit plan compiles");
    let mut control = metadata_control();
    control["metadata_center"]["continuation"]["unknown_control"] = json!(true);
    let error = execute_plan(
        &plan,
        NodeExecutionInput {
            data: json!({"text": "same-shape"}),
            control,
        },
        &StandardHandleRegistry::new(),
    )
    .expect_err("malformed typed control must fail fast");
    assert!(error.to_string().contains("continuation"));
}
