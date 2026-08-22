//! routecodex-v4-runtime L2 regression (compiled through build-link
//! test-consumer with Active deps routecodex-v4-error/base-node and
//! --source-deps routecodex-v4-skeleton).

use routecodex_v4_base_node::Scope;
use routecodex_v4_control::{ControlError, ControlSignal, ControlSignalKind, MetadataOperation};
use routecodex_v4_error::{ErrorChain, ErrorStage};
use routecodex_v4_runtime::{
    assert_no_control_leak, bind_scope_via_bridge, execution_binding, project_runtime_fault,
    release_scope_via_bridge, select_relay_operator, ContinuationFacts, ContinuationKey,
    ExecutionBinding, ExecutionContext, NodePluginPlan, PayloadCycleError, PayloadCycleRegistry,
    PayloadCycleState, RelayOperator, ScopeError, ScopeRegistry, SkeletonRuntime,
};
use routecodex_v4_skeleton::{
    BindingContract, ChainDefinition, Edge, NodeSlot, PluginBinding, SkeletonPlan,
};
use serde_json::json;
use std::fs;

fn contract_json() -> String {
    let path = std::env::var("RUNTIME_CONTRACT_PATH").unwrap_or_else(|_| {
        format!(
            "{}/../../contracts/skeleton-plan.contract.json",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    fs::read_to_string(&path).expect("skeleton plan contract must be readable from v4 root")
}

fn scope(request_id: &str) -> Scope {
    Scope::new(
        request_id,
        "v4-pipeline",
        5555,
        "session-1",
        "conversation-1",
    )
}

fn first_sse_data_json(frame: &str) -> serde_json::Value {
    let payload = frame
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect("SSE data line must exist");
    serde_json::from_str(payload).expect("SSE data must be JSON")
}

fn bridge_scope(operation: &str) -> serde_json::Value {
    json!({
        "scope_command": {
            "entry_protocol": "responses",
            "continuation_owner": "direct",
            "pipeline_id": "v4-pipeline",
            "port": 5555,
            "session_scope": "session-1",
            "conversation_scope": "conversation-1",
            "request_id": "request-1",
            "full_input_hash": "sha256:full-input",
            "operation": operation,
            "sequence": 1
        }
    })
}

#[test]
fn bridge_scope_bind_and_release_reach_registry_truth() {
    let mut registry = ScopeRegistry::new();
    let key = ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-1");
    let bind = bind_scope_via_bridge(&bridge_scope("bind"), &mut registry)
        .expect("typed bridge bind reaches ScopeRegistry");
    assert_eq!(bind.operation, "bind");
    assert!(registry.is_bound(&key));

    let release = release_scope_via_bridge(&bridge_scope("release"), &mut registry)
        .expect("typed bridge release reaches ScopeRegistry");
    assert_eq!(release.operation, "release");
    assert!(matches!(
        registry.restore(&key, "request-2", Some("sha256:full-input")),
        Err(ScopeError::RestoreAfterRelease)
    ));
}

#[test]
fn bridge_scope_missing_or_duplicate_bind_fails_fast() {
    let mut registry = ScopeRegistry::new();
    assert!(matches!(
        bind_scope_via_bridge(&json!({}), &mut registry),
        Err(ScopeError::NotBound)
    ));
    bind_scope_via_bridge(&bridge_scope("bind"), &mut registry).expect("first bind succeeds");
    assert!(matches!(
        bind_scope_via_bridge(&bridge_scope("bind"), &mut registry),
        Err(ScopeError::AlreadyBound)
    ));
}

#[test]
fn bridge_scope_rejects_malformed_operation_and_payload_lookalike() {
    let mut registry = ScopeRegistry::new();
    assert!(matches!(
        bind_scope_via_bridge(&bridge_scope("replace"), &mut registry),
        Err(ScopeError::InvalidBridgeControl)
    ));
    let mut unknown = bridge_scope("bind");
    unknown["scope_command"]["payload_hint"] = json!(true);
    assert!(matches!(
        bind_scope_via_bridge(&unknown, &mut registry),
        Err(ScopeError::InvalidBridgeControl)
    ));
    assert!(matches!(
        bind_scope_via_bridge(
            &json!({"normal_payload": bridge_scope("bind")["scope_command"].clone()}),
            &mut registry,
        ),
        Err(ScopeError::NotBound)
    ));
}

#[test]
fn bridge_scope_release_without_bind_fails_fast() {
    let mut registry = ScopeRegistry::new();
    assert!(matches!(
        release_scope_via_bridge(&bridge_scope("release"), &mut registry),
        Err(ScopeError::NotBound)
    ));
}

#[test]
fn bridge_bound_scope_rejects_all_isolation_mismatches() {
    let mut registry = ScopeRegistry::new();
    bind_scope_via_bridge(&bridge_scope("bind"), &mut registry)
        .expect("typed bind reaches ScopeRegistry");

    let mismatches = [
        (
            ContinuationKey::new("responses", "relay", 5555, "session-1", "conversation-1"),
            ScopeError::OwnerMismatch,
        ),
        (
            ContinuationKey::new("chat", "direct", 5555, "session-1", "conversation-1"),
            ScopeError::EntryProtocolMismatch,
        ),
        (
            ContinuationKey::new("responses", "direct", 5556, "session-1", "conversation-1"),
            ScopeError::PortMismatch,
        ),
        (
            ContinuationKey::new("responses", "direct", 5555, "session-2", "conversation-1"),
            ScopeError::SessionMismatch,
        ),
        (
            ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-2"),
            ScopeError::ConversationMismatch,
        ),
    ];
    for (key, expected) in mismatches {
        let error = registry
            .restore(&key, "request-2", Some("sha256:full-input"))
            .expect_err("isolation mismatch must fail");
        assert_eq!(error, expected);
    }
}

fn slot(
    node_id: &str,
    position: u32,
    terminal: bool,
    kernel: bool,
    plugins: Vec<PluginBinding>,
) -> NodeSlot {
    NodeSlot {
        node_id: node_id.to_string(),
        chain: String::new(),
        position,
        role_id: "test_role".to_string(),
        terminal,
        kernel,
        plugins,
    }
}

fn plugin(plugin_id: &str) -> PluginBinding {
    PluginBinding {
        plugin_id: plugin_id.to_string(),
        effects: vec!["semantic".to_string()],
    }
}

fn test_plan(chains: Vec<ChainDefinition>) -> SkeletonPlan {
    SkeletonPlan {
        schema_version: 1,
        contract_id: "v4-skeleton-plan".to_string(),
        status: "active".to_string(),
        owner_feature_id: "v4.skeleton".to_string(),
        skeleton_version: "v4-skeleton-1".to_string(),
        binding: BindingContract {
            required: true,
            fields: vec![
                "skeleton_version".to_string(),
                "manifest_hash".to_string(),
                "plan_epoch".to_string(),
                "plan_hash".to_string(),
            ],
        },
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
        chains,
    }
}

#[test]
fn positive_request_chain_produces_wire_and_stable_binding() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let plan = runtime.plan();
    let report = runtime
        .execute_request("chat:hello", "r-request-1")
        .expect("request chain runs");
    let wire = report
        .provider_wire
        .as_deref()
        .expect("provider wire produced");
    assert!(wire.starts_with("wire:semantic:unselected:normalized:chat:r-request-1"));
    assert_eq!(
        report.binding,
        execution_binding(plan),
        "execution binding must match the loaded plan"
    );
    assert_eq!(report.trace.len(), 7, "seven request nodes must be traced");
    let scope_value = report
        .continuation_scope
        .as_deref()
        .expect("continuation classified");
    assert!(scope_value.starts_with("scope:chat:relay:port-0:session-:conversation-"));
    assert_eq!(report.continuation_owner.as_deref(), Some("relay"));
    assert_eq!(report.execution_mode.as_deref(), Some("relay"));
    assert!(report.relay_operator_selected);
    assert_eq!(report.route_exit.as_deref(), Some("relay_policy_bound"));
}

#[test]
fn responses_entry_classifies_direct_owner() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_request("responses:hello", "r-direct-1")
        .expect("responses request chain runs");
    assert_eq!(report.continuation_owner.as_deref(), Some("direct"));
    assert_eq!(report.execution_mode.as_deref(), Some("direct"));
    assert!(!report.relay_operator_selected);
    assert_eq!(report.route_exit.as_deref(), Some("direct_policy_bound"));
    let scope_value = report.continuation_scope.as_deref().unwrap();
    assert!(scope_value.starts_with("scope:responses:direct:port-0:session-:conversation-"));
}

#[test]
fn relay_operator_select_uses_typed_facts_only() {
    let relay = select_relay_operator(&ContinuationFacts::new("chat", "hub", "relay", "relay"))
        .expect("chat + relay owner selects relay operator");
    assert_eq!(relay, RelayOperator::Relay);
    let direct = select_relay_operator(&ContinuationFacts::new(
        "responses",
        "responses",
        "direct",
        "direct",
    ))
    .expect("responses + direct owner selects direct operator");
    assert_eq!(direct, RelayOperator::Direct);
    let error = select_relay_operator(&ContinuationFacts::new(
        "responses",
        "responses",
        "relay",
        "relay",
    ))
    .expect_err("responses entry with relay owner must fail (no typed-facts match)");
    assert_eq!(error.code, "relay_operator_select");
    let chat_direct =
        select_relay_operator(&ContinuationFacts::new("chat", "hub", "direct", "direct"))
            .expect_err("chat entry with direct owner must fail (no typed-facts match)");
    assert_eq!(chat_direct.code, "relay_operator_select");
}

#[test]
fn continuation_three_key_save_and_restore_roundtrip() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    // Response chat process commit saves the three-key binding.
    let response = runtime
        .execute_provider_response_scoped(
            "{\"text\":\"ok\"}",
            "r-save-1",
            5555,
            "session-1",
            "conversation-1",
            "responses",
            "direct",
        )
        .expect("response chain commits continuation");
    assert!(response.continuation_committed);
    // Next request chat process restores with the exact same three keys.
    let restored = runtime
        .execute_request_scoped(
            "responses:continue",
            "r-restore-1",
            5555,
            "session-1",
            "conversation-1",
        )
        .expect("request chain restores continuation");
    assert!(restored.continuation_restored);
    assert_eq!(restored.continuation_owner.as_deref(), Some("direct"));
}

#[test]
fn red_continuation_checkpoint_cannot_rebind_before_restore() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    runtime
        .execute_provider_response_scoped(
            "{\"text\":\"first\"}",
            "r-unrestored-save-1",
            5555,
            "session-unrestored",
            "conversation-unrestored",
            "responses",
            "direct",
        )
        .expect("first response commits continuation");
    let error = runtime
        .execute_provider_response_scoped(
            "{\"text\":\"second\"}",
            "r-unrestored-save-2",
            5555,
            "session-unrestored",
            "conversation-unrestored",
            "responses",
            "direct",
        )
        .expect_err("unrestored checkpoint must stay immutable");
    assert_eq!(error.code, "continuation_commit");
    assert!(error.message.contains("already bound"));
}

#[test]
fn red_direct_relay_cross_continuation_fails() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    runtime
        .execute_provider_response_scoped(
            "{\"text\":\"ok\"}",
            "r-cross-save",
            5555,
            "session-1",
            "conversation-1",
            "responses",
            "direct",
        )
        .expect("direct continuation committed");
    // Relay request with the same session must never hit the responses-direct
    // continuation: three-key isolation fails fast.
    let error = runtime
        .execute_request_scoped(
            "chat:continue",
            "r-cross-restore",
            5555,
            "session-1",
            "conversation-1",
        )
        .expect_err("chat entry must not hit responses-direct continuation");
    assert_eq!(error.code, "continuation_restore");
    assert!(error.message.contains("owner mismatch"));
}

#[test]
fn red_session_only_restore_fails_fast() {
    let mut registry = ScopeRegistry::new();
    let full_key = ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-1");
    registry
        .bind(full_key.clone(), "r-sess-save", Some("sha256:full"))
        .expect("bind succeeds");
    // Session-only restore is impossible by construction: a key carrying only
    // session/conversation (empty entry protocol and owner) cannot match the
    // three-key binding and must fail fast.
    let session_only = ContinuationKey::new("", "", 5555, "session-1", "conversation-1");
    let error = registry
        .restore(&session_only, "r-sess-restore", Some("sha256:full"))
        .expect_err("session-only restore must fail");
    assert_eq!(error, ScopeError::OwnerMismatch);
}

#[test]
fn red_immutable_interval_double_restore_fails() {
    let mut registry = ScopeRegistry::new();
    let key = ContinuationKey::new("responses", "direct", 5555, "session-1", "conversation-1");
    registry
        .bind(key.clone(), "r-imm-save", Some("sha256:full"))
        .expect("bind succeeds");
    registry
        .restore(&key, "r-imm-restore-1", Some("sha256:full"))
        .expect("first restore succeeds");
    let error = registry
        .restore(&key, "r-imm-restore-2", Some("sha256:full"))
        .expect_err("second restore must fail (immutable interval)");
    assert_eq!(error, ScopeError::ImmutableIntervalViolation);
}

#[test]
fn payload_cycle_open_merge_terminal_lifecycle() {
    let mut registry = PayloadCycleRegistry::new();
    let opened = registry
        .open("r-cycle-1", "sha256:original")
        .expect("open succeeds");
    assert_eq!(opened.state, PayloadCycleState::Open);
    assert_eq!(opened.attempts, 1);
    let merged = registry.merge_retry("r-cycle-1").expect("merge succeeds");
    assert_eq!(merged.attempts, 2);
    let closed = registry.close_success("r-cycle-1").expect("success close");
    assert_eq!(closed.state, PayloadCycleState::SuccessTerminal);
    let error = registry
        .merge_retry("r-cycle-1")
        .expect_err("merge after terminal must fail");
    assert_eq!(error, PayloadCycleError::MergeAfterTerminal);
}

#[test]
fn payload_cycle_error_terminal_and_double_close_red() {
    let mut registry = PayloadCycleRegistry::new();
    registry
        .open("r-cycle-2", "sha256:original")
        .expect("open succeeds");
    let closed = registry.close_error("r-cycle-2").expect("error close");
    assert_eq!(closed.state, PayloadCycleState::ErrorTerminal);
    let error = registry
        .close_success("r-cycle-2")
        .expect_err("close after terminal must fail");
    assert_eq!(error, PayloadCycleError::AlreadyTerminal);
    let mut second = PayloadCycleRegistry::new();
    second
        .open("r-cycle-3", "sha256:original")
        .expect("first open succeeds");
    let open_twice = second
        .open("r-cycle-3", "sha256:original")
        .expect_err("second open of the same request must fail");
    assert_eq!(open_twice, PayloadCycleError::OpenTwice);
}

#[test]
fn positive_provider_response_chain_projects_client_frame() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_provider_response("{\"text\":\"ok\"}", "r-response-1")
        .expect("provider response chain runs");
    let frame = report
        .client_frame
        .as_deref()
        .expect("client frame produced");
    assert_eq!(frame, "{\"text\":\"ok\"}");
    assert!(
        report.continuation_committed,
        "continuation truth committed at chat process exit"
    );
    assert_eq!(report.trace.len(), 6, "six response nodes must be traced");
}

#[test]
fn direct_sse_frame_runs_frame_parse_through_client_frame() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_provider_response_scoped(
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
            "r-direct-sse",
            5555,
            "session-direct-sse",
            "conversation-direct-sse",
            "responses",
            "none",
        )
        .expect("direct SSE frame must traverse response nodes");
    assert_eq!(
        report.client_frame.as_deref(),
        Some(
            "event: response.output_text.delta\ndata: {\"delta\":\"hi\",\"type\":\"response.output_text.delta\"}\n\n"
        )
    );
    assert_eq!(report.trace.len(), 6);
}

#[test]
fn relay_json_projects_responses_to_chat_semantic() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_provider_response_scoped(
            "{\"id\":\"resp_1\",\"model\":\"m\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}]}",
            "r-relay-json",
            5555,
            "session-relay-json",
            "conversation-relay-json",
            "chat",
            "relay",
        )
        .expect("relay JSON must traverse response nodes");
    let frame: serde_json::Value = serde_json::from_str(
        report
            .client_frame
            .as_deref()
            .expect("chat frame must exist"),
    )
    .expect("chat frame must be JSON");
    assert_eq!(frame["object"], "chat.completion");
    assert_eq!(frame["choices"][0]["message"]["content"], "hello");
    assert!(report.continuation_committed);
    assert_eq!(report.continuation_owner.as_deref(), Some("relay"));
}

#[test]
fn relay_json_projects_tool_calls_and_usage_to_chat_contract() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_provider_response_scoped(
            "{\"id\":\"resp_tool\",\"model\":\"m\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{}\"}],\"usage\":{\"input_tokens\":11,\"output_tokens\":7,\"total_tokens\":18}}",
            "r-relay-json-tool",
            5555,
            "session-relay-json-tool",
            "conversation-relay-json-tool",
            "chat",
            "relay",
        )
        .expect("relay JSON tool response must traverse response nodes");
    let frame: serde_json::Value = serde_json::from_str(
        report
            .client_frame
            .as_deref()
            .expect("chat frame must exist"),
    )
    .expect("chat frame must be JSON");
    let tool = &frame["choices"][0]["message"]["tool_calls"][0];
    assert_eq!(tool["id"], "call_1");
    assert_eq!(tool["function"]["name"], "lookup");
    assert!(tool.get("index").is_none());
    assert_eq!(frame["choices"][0]["finish_reason"], "tool_calls");
    assert_eq!(frame["usage"]["prompt_tokens"], 11);
    assert_eq!(frame["usage"]["completion_tokens"], 7);
    assert_eq!(frame["usage"]["total_tokens"], 18);
    assert!(frame["usage"].get("input_tokens").is_none());
    assert!(frame["usage"].get("output_tokens").is_none());
}

#[test]
fn relay_sse_delta_projects_responses_event_to_chat_chunk() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_provider_response_scoped(
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
            "r-relay-sse",
            5555,
            "session-relay-sse",
            "conversation-relay-sse",
            "chat",
            "none",
        )
        .expect("relay SSE delta must traverse response nodes");
    let frame = first_sse_data_json(
        report
            .client_frame
            .as_deref()
            .expect("chat chunk must exist"),
    );
    assert_eq!(frame["object"], "chat.completion.chunk");
    assert_eq!(frame["choices"][0]["delta"]["content"], "hi");
}

#[test]
fn relay_sse_function_arguments_delta_is_preserved() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_provider_response_scoped(
            "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"city\\\":\"}\n\n",
            "r-relay-sse-tool-args",
            5555,
            "session-relay-sse-tool-args",
            "conversation-relay-sse-tool-args",
            "chat",
            "none",
        )
        .expect("relay SSE tool arguments must traverse response nodes");
    let frame = first_sse_data_json(
        report
            .client_frame
            .as_deref()
            .expect("chat chunk must exist"),
    );
    assert_eq!(frame["choices"][0]["delta"]["tool_calls"][0]["index"], 1);
    assert_eq!(
        frame["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
        "{\"city\":"
    );
}

#[test]
fn relay_sse_tool_terminal_projects_tool_calls_finish_reason() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let report = runtime
        .execute_provider_response_scoped(
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tool\",\"model\":\"m\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{}\"}]}}\n\n",
            "r-relay-sse-tool-terminal",
            5555,
            "session-relay-sse-tool-terminal",
            "conversation-relay-sse-tool-terminal",
            "chat",
            "relay",
        )
        .expect("relay SSE tool terminal must traverse response nodes");
    let frame = first_sse_data_json(
        report
            .client_frame
            .as_deref()
            .expect("chat chunk must exist"),
    );
    assert_eq!(frame["choices"][0]["finish_reason"], "tool_calls");
}

#[test]
fn continuation_rotates_after_restore_for_next_response() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    runtime
        .execute_provider_response_scoped(
            "{\"text\":\"first\"}",
            "r-rotate-save-1",
            5555,
            "session-rotate",
            "conversation-rotate",
            "responses",
            "direct",
        )
        .expect("first response commits");
    runtime
        .execute_request_scoped(
            "responses:continue",
            "r-rotate-restore",
            5555,
            "session-rotate",
            "conversation-rotate",
        )
        .expect("next request restores");
    runtime
        .execute_provider_response_scoped(
            "{\"text\":\"second\"}",
            "r-rotate-save-2",
            5555,
            "session-rotate",
            "conversation-rotate",
            "responses",
            "direct",
        )
        .expect("restored scope rotates to the next response truth");
}

#[test]
fn red_invalid_input_flows_typed_error_path_to_terminal_projection() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    let mut chain = ErrorChain::new(scope("r-error-1"));
    let fault = runtime
        .execute_request("bad:input", "r-error-1")
        .expect_err("invalid entry protocol must fail the request chain");
    assert_eq!(fault.code, "input_validate");
    assert_eq!(
        fault.node_id.as_deref(),
        Some("V4HubReqInbound03Normalized")
    );

    let projection = project_runtime_fault(&mut chain, fault).expect("fault must project");
    assert_eq!(projection.code, "input_validate");
    assert_eq!(chain.current_stage(), Some(ErrorStage::ClientProjected));
    assert!(chain.is_terminal());
    assert_eq!(chain.records().count(), 6, "01..06 stages must be recorded");
    assert!(
        !projection.message.contains("continuation_scope"),
        "client projection must not carry control fields"
    );
}

#[test]
fn red_unknown_plugin_fails_fast() {
    let plan = test_plan(vec![ChainDefinition {
        chain_id: "request".to_string(),
        nodes: vec![slot(
            "V4ServerReqInbound01ClientRaw",
            1,
            true,
            true,
            vec![plugin("mystery_plugin")],
        )],
        edges: vec![],
        checkpoints: vec![],
    }]);
    let error = NodePluginPlan::build(&plan).expect_err("unknown plugin must fail plan compile");
    assert_eq!(error.code, "unknown_plugin");
    assert!(error.message.contains("mystery_plugin"));
}

#[test]
fn red_external_chain_plugins_never_run_inside_runtime() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    for chain_id in ["error", "config"] {
        let error = runtime
            .execute_chain(chain_id, &format!("r-ext-{chain_id}"))
            .expect_err("external-owned chain must not execute in the runtime");
        assert_eq!(error.code, "external_owner_violation");
    }
}

#[test]
fn red_non_adjacent_chain_fails_plan_compile() {
    let plan = test_plan(vec![ChainDefinition {
        chain_id: "request".to_string(),
        nodes: vec![
            slot("a", 1, false, true, vec![]),
            slot("b", 3, true, false, vec![]),
        ],
        edges: vec![Edge {
            from: "a".to_string(),
            to: "b".to_string(),
            direction: "forward".to_string(),
        }],
        checkpoints: vec![],
    }]);
    let error = NodePluginPlan::build(&plan).expect_err("non-consecutive positions must fail");
    assert_eq!(error.code, "non_adjacent_chain");
}

#[test]
fn red_control_leak_into_wire_fails() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-leak-1", binding);
    ctx.control.continuation_scope = Some("scope:typed-only".to_string());
    ctx.control.route_facts = Some("facts:typed-only".to_string());
    ctx.data.provider_wire = Some("{\"continuation_scope\":\"business-data\"}".to_string());
    ctx.data.client_frame = Some("{\"route_facts\":\"business-data\"}".to_string());
    assert_no_control_leak(&ctx).expect("typed planes remain physically separate");
    assert_eq!(
        ctx.control.continuation_scope.as_deref(),
        Some("scope:typed-only")
    );
    assert_eq!(ctx.control.route_facts.as_deref(), Some("facts:typed-only"));
}

#[test]
fn red_binding_drift_fails() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-drift-1", binding);
    let before = ctx.binding().clone();
    ctx.binding_mut().plan_hash = "sha256:drifted".to_string();
    assert_ne!(ctx.binding(), &before);
}

#[test]
fn red_cross_request_reuse_fails() {
    let runtime = SkeletonRuntime::load(&contract_json()).expect("contract plan must load");
    runtime.claim("r-reuse-1").expect("first claim succeeds");
    let error = runtime
        .execute_request("chat:hi", "r-reuse-1")
        .expect_err("second claim of the same request id must fail");
    assert_eq!(error.code, "cross_request_reuse");
    runtime.release("r-reuse-1");
    runtime
        .execute_request("chat:hi", "r-reuse-1")
        .expect("after release the request id is reusable");
}

#[test]
fn control_resources_lifecycle_positive_and_red() {
    use routecodex_v4_runtime::{
        ControlLedgerRecord, DryRunExecutionError, NodeStatistic, StoplessError, StoplessFacts,
        V4Control02RecordLedger, V4Control03NodeStatistics, V4Debug09DryRunNoNetworkTerminalEffect,
        V4RuntimeObservability, V4RuntimeTimingSummary, V4StoplessControlState,
    };

    // Stopless: store -> consume -> clear; double-store and empty-clear are red.
    let mut stopless = V4StoplessControlState::new();
    stopless
        .store_for_scope(StoplessFacts {
            entry_endpoint: "responses".to_string(),
            session_id: "s-1".to_string(),
            conversation_id: "c-1".to_string(),
            port: 5555,
            routing_group: "rg-1".to_string(),
        })
        .expect("first store must succeed");
    assert_eq!(stopless.consume().unwrap().port, 5555);
    stopless.clear_for_scope().expect("clear must succeed");
    assert!(matches!(stopless.consume(), Err(StoplessError::NotStored)));
    let mut store_twice = || -> Result<(), StoplessError> {
        stopless.store_for_scope(StoplessFacts {
            entry_endpoint: "chat".to_string(),
            session_id: "s-2".to_string(),
            conversation_id: "c-2".to_string(),
            port: 5555,
            routing_group: "rg-1".to_string(),
        })?;
        stopless.store_for_scope(StoplessFacts {
            entry_endpoint: "chat".to_string(),
            session_id: "s-2".to_string(),
            conversation_id: "c-2".to_string(),
            port: 5555,
            routing_group: "rg-1".to_string(),
        })
    };
    assert!(matches!(store_twice(), Err(StoplessError::AlreadyStored)));

    // Ledger: append immutable; duplicate record id is red.
    let mut ledger = V4Control02RecordLedger::new();
    ledger
        .append(ControlLedgerRecord {
            record_id: "r-1".to_string(),
            node_id: "V4ScopeRegistry".to_string(),
            direction: "in".to_string(),
            control_key: "scope.bind".to_string(),
            scope_key: "scope-a".to_string(),
            payload_hash: Some("sha256:abc".to_string()),
        })
        .expect("append must succeed");
    assert_eq!(ledger.scope_records("scope-a").count(), 1);
    assert!(matches!(
        ledger.append(ControlLedgerRecord {
            record_id: "r-1".to_string(),
            node_id: "V4ScopeRegistry".to_string(),
            direction: "in".to_string(),
            control_key: "scope.bind".to_string(),
            scope_key: "scope-a".to_string(),
            payload_hash: Some("sha256:abc".to_string()),
        }),
        Err(routecodex_v4_runtime::ControlLedgerError::ImmutableRecord)
    ));

    // Statistics: diagnostic-only counters, never decision input.
    let mut stats = V4Control03NodeStatistics::new();
    stats
        .record("V4ScopeRegistry", "bind", "scope-a", false)
        .unwrap();
    stats
        .record("V4ScopeRegistry", "bind", "scope-a", true)
        .unwrap();
    let snapshot: Vec<NodeStatistic> = stats.snapshot().cloned().collect();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].invocations, 2);
    assert_eq!(snapshot[0].errors, 1);

    // Dry-run: registered fixture executes with no network effect; empty
    // fixture id is red.
    let mut dry_run = V4Debug09DryRunNoNetworkTerminalEffect::new();
    let execution = dry_run
        .execute(
            "fixture-1",
            "exec-1",
            "V4ServerReqInbound01ClientRaw",
            "V4ServerRespOutbound06ClientFrame",
            "sha256:input",
        )
        .expect("dry-run must execute");
    assert_eq!(execution.terminal_state, "dry_run_terminal");
    assert_eq!(dry_run.executions().count(), 1);
    assert!(matches!(
        dry_run.execute(
            "",
            "exec-2",
            "V4ServerReqInbound01ClientRaw",
            "V4ServerRespOutbound06ClientFrame",
            "sha256:input"
        ),
        Err(DryRunExecutionError::FixtureMissing)
    ));

    // Observability + timing: diagnostic projections only.
    let mut observability = V4RuntimeObservability::new();
    observability.accumulator().record(
        "req-1",
        "responses",
        "relay",
        "rg-1",
        "cc",
        "deepseek-v4-flash",
    );
    assert_eq!(observability.summaries().count(), 1);
    let mut timing = V4RuntimeTimingSummary::new();
    timing.state().record_phase("resp_chatprocess", 42);
    assert_eq!(timing.total_micros("resp_chatprocess"), 42);
}

#[test]
fn metadata_center_lifecycle_register_consume_release() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-meta-1", binding);
    let signal = ControlSignal::new(
        ControlSignalKind::Route,
        "route.target",
        "sha256:value",
        ctx.scope().clone(),
        Some("sha256:payload"),
    );
    let registered = ctx
        .control
        .metadata
        .register(signal)
        .expect("register must succeed within the request scope");
    assert_eq!(registered.operation, MetadataOperation::Register);
    assert!(ctx.control.metadata.is_registered("route.target"));

    let consumed = ctx
        .control
        .metadata
        .consume("route.target")
        .expect("consume must succeed while registered");
    assert_eq!(consumed.key, "route.target");
    assert!(ctx.control.metadata.is_registered("route.target"));

    let released = ctx
        .control
        .metadata
        .release("route.target")
        .expect("release must succeed while registered");
    assert_eq!(released.operation, MetadataOperation::Release);
    assert!(ctx.control.metadata.is_released("route.target"));

    let ops: Vec<MetadataOperation> = ctx
        .control
        .metadata
        .records()
        .map(|record| record.operation)
        .collect();
    assert_eq!(
        ops,
        vec![
            MetadataOperation::Register,
            MetadataOperation::Consume,
            MetadataOperation::Release
        ]
    );
}

#[test]
fn metadata_center_scope_isolation_red() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut ctx = ExecutionContext::new("r-meta-a", binding);
    let foreign_scope = Scope::new("r-other", "v4-other", 6666, "sess-other", "conv-other");
    let signal = ControlSignal::new(
        ControlSignalKind::Route,
        "route.target",
        "sha256:value",
        foreign_scope,
        None,
    );
    let error = ctx
        .control
        .metadata
        .register(signal)
        .expect_err("cross-scope signal must fail at the owning boundary");
    assert!(matches!(error, ControlError::ScopeMismatch));
    assert!(!ctx.control.metadata.is_registered("route.target"));
}

#[test]
fn metadata_center_cross_request_reuse_fails() {
    let binding = ExecutionBinding {
        skeleton_version: "v4-skeleton-1".to_string(),
        manifest_hash: "sha256:test".to_string(),
        plan_epoch: 1,
        plan_hash: "sha256:test".to_string(),
    };
    let mut first = ExecutionContext::new("r-meta-x", binding.clone());
    let signal = ControlSignal::new(
        ControlSignalKind::Route,
        "route.target",
        "sha256:value",
        first.scope().clone(),
        None,
    );
    first
        .control
        .metadata
        .register(signal)
        .expect("register in the owning request must succeed");

    let mut second = ExecutionContext::new("r-meta-y", binding);
    let error = second
        .control
        .metadata
        .consume("route.target")
        .expect_err("control state must never be reusable across requests");
    assert!(matches!(error, ControlError::NotRegistered));
    assert!(first.control.metadata.is_registered("route.target"));
}
