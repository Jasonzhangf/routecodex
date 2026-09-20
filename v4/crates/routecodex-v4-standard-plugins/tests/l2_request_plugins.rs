//! Request-side P0 plugin positive and negative contract coverage.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(
    node: &str,
    role: &str,
    position: u32,
    plugin: &str,
    data: Value,
) -> Result<Value, NodeContainerError> {
    execute_with_context(node, role, position, plugin, data, json!({}), json!({}))
}

fn execute_with_context(
    node: &str,
    role: &str,
    position: u32,
    plugin: &str,
    data: Value,
    control: Value,
    information: Value,
) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(node, role, "request", position, &[plugin]).unwrap();
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash.clone(),
    };
    let mut container = NodeContainer::declare(node, plan, bindings).unwrap();
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container.execute_with_plan_hash(
        &hash,
        NodeExecutionInput {
            data,
            control,
            information,
            transport: None,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output.map(|value| value.data)
}

fn execute_with_information(
    node: &str,
    role: &str,
    position: u32,
    plugin: &str,
    data: Value,
    information: Value,
) -> Result<Value, NodeContainerError> {
    execute_with_context(node, role, position, plugin, data, json!({}), information)
}

#[test]
fn positive_request_plugins_preserve_adjacent_semantics() {
    let normalized = execute(
        "V4HubReqInbound02Normalized",
        "request_inbound",
        2,
        "v4.std.request.responses_normalize",
        json!({"model":"m","messages":[{"role":"user","content":"hi"}]}),
    )
    .unwrap();
    assert!(normalized.get("requestId").is_none());
    let governed = execute(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        3,
        "v4.std.chat_process.request_governance",
        normalized,
    )
    .unwrap();
    let semantic = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        governed,
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses"}),
    )
    .unwrap();
    assert_eq!(semantic["protocol"], json!("responses"));
    assert!(semantic.get("messages").is_none());
    let wire = execute_with_context(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        semantic,
        json!({
            "request_admission_facts": {"model": "m", "stream": false}
        }),
        json!({
            "client_protocol": "openai-chat",
            "provider_protocol": "openai-responses",
            "model": "m"
        }),
    )
    .unwrap();
    assert_eq!(wire["model"], json!("m"));
}

#[test]
fn negative_request_plugins_reject_control_leakage_and_invalid_shapes() {
    assert!(execute(
        "V4HubReqInbound02Normalized",
        "request_inbound",
        2,
        "v4.std.request.responses_normalize",
        json!({"input":[],"requestId":"control-must-not-enter-payload"})
    )
    .is_err());
    assert!(execute(
        "V4HubReqChatProcess03Governed",
        "request_chat_process",
        3,
        "v4.std.chat_process.request_governance",
        json!({"messages":[],"tools":{}})
    )
    .is_err());
    assert!(execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({"model":"m","messages":[]}),
        json!({"client_protocol":"openai-chat","provider_protocol":"anthropic-messages"})
    )
    .is_err());
    assert!(execute(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({"model":"m","input":[],"error_chain":{}})
    )
    .is_err());
}

#[test]
fn responses_wire_builder_preserves_protocol_continuation_fields() {
    let wire = execute_with_context(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({
            "model": "m",
            "input": "next",
            "previous_response_id": "resp_previous",
            "store": true
        }),
        json!({
            "request_admission_facts": {"model": "m", "stream": false}
        }),
        json!({
            "client_protocol": "openai-responses",
            "provider_protocol": "openai-responses",
            "model": "m"
        }),
    )
    .expect("wire builder preserves valid Responses fields");
    assert_eq!(wire["previous_response_id"], "resp_previous");
    assert_eq!(wire["store"], true);
}

#[test]
fn wire_builder_preserves_chat_shape_for_same_protocol() {
    let wire = execute_with_context(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({"model": "m", "messages": [{"role": "user", "content": "hello"}]}),
        json!({
            "request_admission_facts": {"model": "m", "stream": false}
        }),
        json!({"client_protocol": "chat", "provider_protocol": "chat", "model": "m"}),
    )
    .expect("same-protocol Chat wire must remain Chat-shaped");
    assert_eq!(wire["messages"][0]["content"], "hello");
    assert!(wire.get("input").is_none());
}

#[test]
fn wire_builder_rejects_missing_protocol_side_channel() {
    assert!(execute_with_information(
        "V4ProviderReqCompat07ProviderCompat",
        "request_outbound",
        7,
        "v4.std.request.responses_wire_build",
        json!({"model": "m", "messages": []}),
        json!({}),
    )
    .is_err());
}

#[test]
fn direct_and_relay_model_hooks_are_protocol_scoped() {
    let direct = execute_with_context(
        "V4DirectReq02RelayContainer",
        "request_outbound",
        2,
        "v4.hook.direct.request",
        json!({"model":"gpt-5.6-sol","input":"hi"}),
        json!({
            "request_admission_facts": {"model": "gpt-5.6-sol", "stream": false}
        }),
        json!({"client_protocol":"openai-responses","provider_protocol":"openai-responses", "model":"gpt-5.6-sol"}),
    )
    .unwrap();
    assert_eq!(direct["model"], json!("gpt-5.6-sol"));
    assert!(execute_with_information(
        "V4DirectReq02RelayContainer",
        "request_outbound",
        2,
        "v4.hook.direct.request",
        json!({"model":"m","input":[]}),
        json!({"client_protocol":"openai-responses","provider_protocol":"openai-chat"}),
    )
    .is_err());
    let relay = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({"model":"m","messages":[{"role":"user","content":"hi"}]}),
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses"}),
    )
    .unwrap();
    assert_eq!(relay["protocol"], json!("responses"));
    assert!(relay.get("messages").is_none());
}

#[test]
fn relay_request_projects_responses_to_openai_chat_without_dropping_tools() {
    let semantic = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({
            "model": "gpt-5.5",
            "instructions": "be concise",
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}
            ],
            "tools": [
                {"type":"function","name":"lookup","description":"lookup","parameters":{"type":"object"}}
            ]
        }),
        json!({
            "client_protocol": "openai-responses",
            "provider_protocol": "openai-chat"
        }),
    )
    .expect("Responses to OpenAI Chat is a registered Relay projection");

    assert_eq!(semantic["messages"][0]["role"], json!("system"));
    assert_eq!(semantic["messages"][0]["content"], json!("be concise"));
    assert_eq!(semantic["messages"][1]["role"], json!("user"));
    assert_eq!(semantic["messages"][1]["content"], json!("hello"));
    assert_eq!(semantic["tools"][0]["type"], json!("function"));
    assert_eq!(semantic["tools"][0]["function"]["name"], json!("lookup"));
    assert!(semantic.get("input").is_none());
}

#[test]
fn relay_request_projects_responses_sampling_tool_choice_and_format_fields() {
    let semantic = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({
            "model": "gpt-5.5",
            "input": "hello",
            "max_output_tokens": 512,
            "tool_choice": {"type":"function","name":"lookup"},
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "answer",
                    "schema": {"type":"object","properties":{"answer":{"type":"string"}}},
                    "strict": true
                }
            }
        }),
        json!({
            "client_protocol": "openai-responses",
            "provider_protocol": "openai-chat"
        }),
    )
    .expect("Responses sampling, tool choice, and format fields must project");

    assert_eq!(semantic["max_completion_tokens"], json!(512));
    assert!(semantic.get("max_tokens").is_none());
    assert_eq!(semantic["tool_choice"]["type"], json!("function"));
    assert_eq!(semantic["tool_choice"]["function"]["name"], json!("lookup"));
    assert_eq!(
        semantic["response_format"]["json_schema"]["name"],
        json!("answer")
    );
}

#[test]
fn relay_request_rejects_malformed_responses_tool_choice_and_response_format() {
    for (field, value, expected) in [
        ("tool_choice", json!({"type":"function"}), "tool_choice"),
        (
            "response_format",
            json!({"type":"json_schema","json_schema":{"schema":{"type":"object"}}}),
            "response_format",
        ),
    ] {
        let mut request = json!({"model":"gpt-5.5","input":"hello"});
        request[field] = value;
        let error = execute_with_information(
            "V4HubReqOutbound06ProviderSemantic",
            "request_outbound",
            6,
            "v4.hook.relay.request",
            request,
            json!({
                "client_protocol": "openai-responses",
                "provider_protocol": "openai-chat"
            }),
        )
        .expect_err("malformed cross-protocol fields must fail");
        assert!(
            format!("{error}").contains(expected),
            "failure must identify {expected}: {error}"
        );
    }
}

#[test]
fn relay_request_preserves_responses_tool_history_for_openai_chat() {
    let semantic = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({
            "model": "gpt-5.5",
            "input": [
                {"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\"q\":\"x\"}"},
                {"type":"function_call_output","call_id":"call_1","output":"ok"}
            ]
        }),
        json!({
            "client_protocol": "openai-responses",
            "provider_protocol": "openai-chat"
        }),
    )
    .expect("tool history must retain call identity in the Chat wire");

    assert_eq!(
        semantic["messages"][0]["tool_calls"][0]["id"],
        json!("call_1")
    );
    assert_eq!(
        semantic["messages"][0]["tool_calls"][0]["function"]["name"],
        json!("lookup")
    );
    assert_eq!(semantic["messages"][1]["tool_call_id"], json!("call_1"));
    assert_eq!(semantic["messages"][1]["content"], json!("ok"));
}

#[test]
fn relay_request_rejects_unmapped_responses_to_chat_field() {
    let error = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({
            "model": "gpt-5.5",
            "input": "hello",
            "previous_response_id": "resp_previous"
        }),
        json!({
            "client_protocol": "openai-responses",
            "provider_protocol": "openai-chat"
        }),
    )
    .expect_err("Responses-only continuation fields must fail instead of being silently dropped");
    assert!(
        format!("{error}").contains("previous_response_id"),
        "failure must identify the unmapped field: {error}"
    );
}

#[test]
fn relay_request_rejects_responses_only_fields_instead_of_leaking_them_to_chat() {
    for field in [
        json!({"background": true}),
        json!({"reasoning": {"effort": "high"}}),
        json!({"text": {"verbosity": "low"}}),
        json!({"include": ["reasoning.encrypted_content"]}),
        json!({"truncation": "auto"}),
        json!({"prompt_cache_key": "cache-key"}),
    ] {
        let mut request = json!({
            "model": "gpt-5.5",
            "input": "hello"
        });
        let (field, value) = field.as_object().unwrap().iter().next().unwrap();
        request[field] = value.clone();
        let error = execute_with_information(
            "V4HubReqOutbound06ProviderSemantic",
            "request_outbound",
            6,
            "v4.hook.relay.request",
            request,
            json!({
                "client_protocol": "openai-responses",
                "provider_protocol": "openai-chat"
            }),
        )
        .expect_err("unmapped Responses fields must fail before provider wire");
        assert!(
            format!("{error}").contains(field),
            "failure must identify {field}: {error}"
        );
    }
}

#[test]
fn relay_request_rejects_unknown_responses_fields_instead_of_forwarding_them() {
    let error = execute_with_information(
        "V4HubReqOutbound06ProviderSemantic",
        "request_outbound",
        6,
        "v4.hook.relay.request",
        json!({
            "model": "gpt-5.5",
            "input": "hello",
            "unmapped_provider_field": "must-not-cross"
        }),
        json!({
            "client_protocol": "openai-responses",
            "provider_protocol": "openai-chat"
        }),
    )
    .expect_err("unknown Responses fields must not be forwarded to Chat wire");
    assert!(
        format!("{error}").contains("unmapped_provider_field"),
        "failure must identify the unknown field: {error}"
    );
}
