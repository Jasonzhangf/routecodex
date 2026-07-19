use async_trait::async_trait;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_local_continuation, V3ResponsesRelayClientBody,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Mutex};

struct SequentialJsonTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
}

struct StoplessSseTransport {
    captures: Mutex<Vec<Value>>,
}

struct ApplyPatchSseTransport {
    captures: Mutex<Vec<Value>>,
}

fn stopless_projected_call(body: &Value) -> &Value {
    body["output"]
        .as_array()
        .expect("stopless response output array")
        .iter()
        .find(|item| item["call_id"] == json!("call_stopless_reasoning"))
        .expect("projected stopless exec_command call")
}

fn stopless_cli_input_from_client_body(body: &Value) -> Value {
    let arguments = stopless_projected_call(body)["arguments"]
        .as_str()
        .expect("stopless projection arguments");
    let parsed: Value = serde_json::from_str(arguments).expect("arguments JSON");
    let cmd = parsed["cmd"].as_str().expect("exec_command cmd");
    let marker = "--input-json '";
    let start = cmd.find(marker).expect("input-json marker") + marker.len();
    let rest = &cmd[start..];
    let end = rest.find('\'').expect("closing input-json quote");
    serde_json::from_str(&rest[..end]).expect("stopless CLI input JSON")
}

fn provider_tool_names(body: &Value) -> Vec<String> {
    let mut names = Vec::new();
    collect_tool_names_from_array(body.get("tools"), &mut names);
    for item in body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_tool_names_from_array(item.get("tools"), &mut names);
        }
    }
    names
}

fn provider_reasoning_stop_tool(body: &Value) -> &Value {
    let mut matches = Vec::new();
    collect_reasoning_stop_tools_from_array(body.get("tools"), &mut matches);
    for item in body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_reasoning_stop_tools_from_array(item.get("tools"), &mut matches);
        }
    }
    assert_eq!(
        matches.len(),
        1,
        "provider request must expose exactly one internal reasoningStop tool across original tool JSON paths: {body}"
    );
    matches[0]
}

fn collect_reasoning_stop_tools_from_array<'a>(value: Option<&'a Value>, out: &mut Vec<&'a Value>) {
    if let Some(tools) = value.and_then(Value::as_array) {
        out.extend(
            tools
                .iter()
                .filter(|tool| tool_name(tool) == Some("reasoningStop")),
        );
    }
}

fn collect_tool_names_from_array(value: Option<&Value>, names: &mut Vec<String>) {
    if let Some(tools) = value.and_then(Value::as_array) {
        names.extend(
            tools
                .iter()
                .filter_map(|tool| tool_name(tool).map(str::to_string)),
        );
    }
}

fn tool_name(tool: &Value) -> Option<&str> {
    tool.get("name")
        .or_else(|| {
            tool.get("function")
                .and_then(|function| function.get("name"))
        })
        .and_then(Value::as_str)
}

fn assert_provider_stopless_guidance(body: &Value) {
    let names = provider_tool_names(body);
    assert_eq!(
        names
            .iter()
            .filter(|name| name.as_str() == "reasoningStop")
            .count(),
        1,
        "provider request must expose exactly one internal reasoningStop tool at the original tool JSON path, got {names:?}"
    );
    let reasoning_stop_tool = provider_reasoning_stop_tool(body);
    let reasoning_stop_description = reasoning_stop_tool["description"]
        .as_str()
        .expect("reasoningStop tool description");
    for required in [
        "Minimal continue sample",
        "Minimal finished sample",
        "Minimal blocked sample",
        "Schema repair sample",
        "stopreason=0",
        "stopreason=1",
        "stopreason=2",
    ] {
        assert!(
            reasoning_stop_description.contains(required),
            "reasoningStop tool description missing V2-parity sample token {required}: {reasoning_stop_description}"
        );
    }
    let instructions = body
        .get("instructions")
        .and_then(Value::as_str)
        .expect("stopless provider request must carry schema guidance instructions");
    for required in [
        "reasoningStop",
        "<rcc_stop_schema>",
        "stopreason",
        "has_evidence",
        "evidence",
        "current_goal",
        "next_step",
        "needs_user_input",
    ] {
        assert!(
            instructions.contains(required),
            "provider instructions missing full schema guidance token {required}: {instructions}"
        );
    }
}

fn assert_original_tools_preserved(body: &Value, expected_original_tools: &[Value]) {
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .expect("original request path $.tools must still exist before provider send");
    assert_eq!(
        tools.len(),
        expected_original_tools.len() + 1,
        "original request path $.tools must preserve original tools and append exactly one internal reasoningStop tool: {tools:?}"
    );
    for (index, expected) in expected_original_tools.iter().enumerate() {
        assert_eq!(
            &tools[index], expected,
            "original $.tools[{index}] changed before provider send"
        );
    }
    assert_eq!(
        tools[expected_original_tools.len()]
            .get("name")
            .or_else(|| {
                tools[expected_original_tools.len()]
                    .get("function")
                    .and_then(|function| function.get("name"))
            })
            .and_then(Value::as_str),
        Some("reasoningStop"),
        "provider request must append reasoningStop after original $.tools entries: {tools:?}"
    );
}

fn assert_no_original_tools_injects_single_top_level_reasoning_stop(body: &Value) {
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .expect("provider request with no original tools must create the only legal Responses $.tools injection surface");
    assert_eq!(
        tools.len(),
        1,
        "no-original-tools provider request must contain exactly one injected reasoningStop tool: {tools:?}"
    );
    assert_eq!(
        tools[0]
            .get("name")
            .or_else(|| tools[0]
                .get("function")
                .and_then(|function| function.get("name")))
            .and_then(Value::as_str),
        Some("reasoningStop"),
        "no-original-tools provider request must inject only reasoningStop: {tools:?}"
    );
    let additional_tools_count = body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("additional_tools"))
        .count();
    assert_eq!(
        additional_tools_count, 0,
        "no-original-tools request must not synthesize Responses input.additional_tools: {body}"
    );
}

fn assert_additional_tools_preserved_without_shape_rebuild(
    body: &Value,
    expected_original_tools: &[Value],
) {
    assert!(
        body.get("tools").is_none(),
        "request path $.tools must be absent because the original request did not contain $.tools: {body}"
    );
    let additional_tools_items = body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("additional_tools"))
        .collect::<Vec<_>>();
    assert_eq!(
        additional_tools_items.len(),
        1,
        "provider request must keep the original $.input[].type=additional_tools item in place: {body}"
    );
    let tools = additional_tools_items[0]["tools"]
        .as_array()
        .expect("original additional_tools path $.input[].tools must stay an array");
    assert_eq!(
        tools.len(),
        expected_original_tools.len() + 1,
        "original additional_tools path $.input[].tools must stay unchanged except one appended reasoningStop: {tools:?}"
    );
    for (index, expected) in expected_original_tools.iter().enumerate() {
        assert_eq!(
            &tools[index], expected,
            "original $.input[].tools[{index}] changed before provider send"
        );
    }
    assert_eq!(
        tools[expected_original_tools.len()]
            .get("name")
            .or_else(|| {
                tools[expected_original_tools.len()]
                    .get("function")
                    .and_then(|function| function.get("name"))
            })
            .and_then(Value::as_str),
        Some("reasoningStop"),
        "provider request must append reasoningStop after original $.input[].tools entries: {tools:?}"
    );
    assert!(
        body.get("tools").is_none(),
        "provider request created a sibling tool declaration surface that was not present in the original request path: {body}"
    );
}

fn assert_no_schema_feedback_prompt(item: &Value) {
    assert_eq!(item.get("role").and_then(Value::as_str), Some("user"));
    let content = item
        .get("content")
        .and_then(Value::as_str)
        .expect("no_schema feedback prompt");
    assert!(content.contains("缺少 stop schema"));
    assert!(content.contains("stopreason"));
    assert!(content.contains("<rcc_stop_schema>"));
    assert!(!content.trim().eq("继续。"));
}

fn assert_invalid_schema_feedback_prompt(item: &Value) {
    assert_eq!(item.get("role").and_then(Value::as_str), Some("user"));
    let content = item
        .get("content")
        .and_then(Value::as_str)
        .expect("invalid_schema feedback prompt");
    assert!(content.contains("stop schema 无效"));
    assert!(content.contains("reasonCode"));
    assert!(content.contains("0/1/2"));
    assert!(!content.trim().eq("继续。"));
}

fn is_structured_stopless_shell_artifact(item: &Value) -> bool {
    if item.get("call_id").and_then(Value::as_str) == Some("call_stopless_reasoning") {
        return true;
    }
    if !matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "tool_call")
    ) {
        return false;
    }
    item.get("arguments")
        .or_else(|| item.get("input"))
        .and_then(Value::as_str)
        .is_some_and(|arguments| arguments.contains("routecodex hook run reasoningStop"))
}

fn assert_no_stopless_shell_artifacts(body: &Value) {
    for item in body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        assert!(
            !is_structured_stopless_shell_artifact(item),
            "provider payload leaked structured stopless shell artifact: {item}"
        );
        assert_no_structured_stopless_control_fields(item, "provider.input[]");
    }
}

fn assert_no_structured_stopless_control_fields(value: &Value, path: &str) {
    match value {
        Value::Object(object) => {
            for key in object.keys() {
                assert!(
                    !matches!(
                        key.as_str(),
                        "repeatCount"
                            | "maxRepeats"
                            | "triggerHint"
                            | "schemaFeedback"
                            | "reasonCode"
                            | "missingFields"
                    ),
                    "provider normal input leaked structured stopless control field {path}.{key}: {value}"
                );
            }
            for (key, child) in object {
                assert_no_structured_stopless_control_fields(
                    child,
                    format!("{path}.{key}").as_str(),
                );
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                assert_no_structured_stopless_control_fields(
                    child,
                    format!("{path}[{index}]").as_str(),
                );
            }
        }
        _ => {}
    }
}

#[async_trait]
impl ResponsesTransport for SequentialJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        let response = self.responses.lock().unwrap().pop_front().unwrap();
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&response).unwrap(),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for StoplessSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        let stream = futures_util::stream::iter([
            Ok(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"streamed stopless without schema\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stopless_sse\",\"object\":\"response\",\"status\":\"completed\",\"finish_reason\":\"stop\",\"output\":[]}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]);
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for ApplyPatchSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures.lock().unwrap().push(request.body().clone());
        let patch = "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch";
        let arguments = serde_json::to_string(&json!({"patch": patch})).unwrap();
        let added = json!({
            "type":"response.output_item.added",
            "output_index":0,
            "item":{
                "type":"function_call",
                "call_id":"call_apply_patch_sse",
                "name":"apply_patch",
                "arguments":""
            }
        });
        let arguments_done = json!({
            "type":"response.function_call_arguments.done",
            "output_index":0,
            "call_id":"call_apply_patch_sse",
            "arguments":arguments
        });
        let completed = json!({
            "type":"response.completed",
            "response":{
                "id":"resp_apply_patch_sse",
                "object":"response",
                "status":"completed",
                "finish_reason":"tool_calls",
                "output":[]
            }
        });
        let stream = futures_util::stream::iter([
            Ok(format!("event: response.output_item.added\ndata: {added}\n\n").into_bytes()),
            Ok(
                format!("event: response.function_call_arguments.done\ndata: {arguments_done}\n\n")
                    .into_bytes(),
            ),
            Ok(format!("event: response.completed\ndata: {completed}\n\n").into_bytes()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]);
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream),
        ))
    }
}

#[tokio::test]
async fn json_runtime_enables_stopless_response_projection_and_next_request_rewrite() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_stopless_runtime_1",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"runtime missing stop schema"}]
                }]
            }),
            json!({
                "id":"resp_stopless_runtime_2",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"output_text","text":"done {\"stopreason\":0,\"reason\":\"done\",\"has_evidence\":1,\"evidence\":\"runtime completed\"}"}]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-runtime",
        "conversation-stopless-runtime",
        5555,
        "controlled",
    );

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-runtime-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Trigger stopless"}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        30_000,
    )
    .await
    .unwrap();
    let first_observability = first
        .observability
        .as_ref()
        .expect("JSON stopless turn must expose observability");
    assert_eq!(
        first_observability.response_status.as_deref(),
        Some("requires_action")
    );
    assert_eq!(first_observability.finish_reason.as_deref(), Some("stop"));
    assert!(first_observability.stopless_activation);
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action");
            let call = stopless_projected_call(&body);
            assert_eq!(call["name"], "exec_command");
            assert_eq!(call["call_id"], "call_stopless_reasoning");
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("first stopless turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-runtime-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"continue from stopless runtime\"}"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        31_000,
    )
    .await
    .unwrap();
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("second stopless turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(
        captures[1]["input"],
        json!([
            {"role":"user","content":"Trigger stopless"},
            {"role":"user","content":"continue from stopless runtime"}
        ])
    );
    for capture in captures.iter() {
        assert_provider_stopless_guidance(capture);
        assert_no_stopless_shell_artifacts(capture);
    }
}

#[tokio::test]
async fn json_runtime_preserves_responses_reasoning_and_visible_text_fields_to_client() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_reasoning_text_runtime",
            "status":"completed",
            "output":[
                {
                    "type":"reasoning",
                    "summary":[{"type":"summary_text","text":"reasoning trace"}]
                },
                {
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"visible answer"}]
                }
            ]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-reasoning-text-runtime",
        "conversation-reasoning-text-runtime",
        5555,
        "controlled",
    );

    let response = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-reasoning-text-runtime".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Return reasoning and visible text"}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        32_000,
    )
    .await
    .unwrap();
    match response.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            assert_eq!(body["output"][0]["type"], "reasoning");
            assert_eq!(
                body["output"][0]["summary"][0]["text"], "reasoning trace",
                "client projection must keep Responses reasoning.summary in the reasoning slot"
            );
            assert_eq!(body["output"][1]["type"], "message");
            assert_eq!(
                body["output"][1]["content"][0]["text"], "visible answer",
                "client projection must keep Responses output_text as visible text"
            );
            assert!(
                body["output"][1]["content"][0].get("summary").is_none(),
                "visible text item must not absorb reasoning summary fields"
            );
        }
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("reasoning/text JSON response must project JSON client body")
        }
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_no_original_tools_injects_single_top_level_reasoning_stop(&captures[0]);
    assert_provider_stopless_guidance(&captures[0]);
    assert_no_stopless_shell_artifacts(&captures[0]);
}

#[tokio::test]
async fn provider_request_dry_run_uses_live_local_continuation_state() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_stopless_dry_run_preserve_tools_1",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{
                    "type":"output_text",
                    "text":"{\"stopreason\":2,\"reason\":\"round one\",\"next_step\":\"continue and keep tools\"}"
                }]
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-dry-run",
        "conversation-stopless-dry-run",
        5555,
        "controlled",
    );
    let original_tools =
        json!([{"type":"function","name":"exec_command","description":"run command"}]);
    let original_request = json!({
        "model":"client-responses",
        "input":[
            {
                "type":"additional_tools",
                "role":"developer",
                "tools": original_tools.clone()
            },
            {
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"Trigger stopless with tools"}]
            }
        ],
        "stream":false
    });

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-dry-run-1".into(),
            payload: original_request.clone(),
        },
        &transport,
        &state,
        scope.clone(),
        70_000,
    )
    .await
    .unwrap();
    let first_body = match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("first stopless turn must be JSON"),
    };
    assert_eq!(first_body["status"], "requires_action");
    assert_eq!(state.len().unwrap(), 1);

    let submit_payload = json!({
        "model":"client-responses",
        "previous_response_id": first_body["id"].as_str().unwrap(),
        "input":[{
            "type":"function_call_output",
            "call_id":"call_stopless_reasoning",
            "output":"{\"current_goal\":\"preserve the original provider tool JSON path\",\"next_step\":\"continue and keep tools\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"non_terminal_schema\"}}"
        }],
        "stream":false
    });

    let dry_run =
        routecodex_v3_runtime::execute_v3_responses_relay_dry_run_runtime_with_local_continuation(
            &manifest(),
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                request_id: "req-stopless-dry-run-2".into(),
                payload: submit_payload.clone(),
            },
            &state,
            scope.clone(),
            71_000,
        )
        .await;

    assert_eq!(dry_run.status, 200);
    let provider_request = dry_run
        .body
        .get("providerRequest")
        .expect("dry-run provider request");
    let body = provider_request
        .get("body")
        .or_else(|| provider_request.get("payload"))
        .or(Some(provider_request))
        .unwrap();
    let input = body["input"]
        .as_array()
        .expect("provider request input must be array");
    assert_eq!(
        input[1]["content"][0]["text"],
        "Trigger stopless with tools"
    );
    assert_eq!(input[2]["role"], "user");
    assert_eq!(input[2]["content"], "continue and keep tools");
    assert_additional_tools_preserved_without_shape_rebuild(
        body,
        original_tools.as_array().unwrap(),
    );
    assert_provider_stopless_guidance(body);
    assert_no_stopless_shell_artifacts(body);
    assert_eq!(
        state.len().unwrap(),
        1,
        "provider-request dry-run must not release or commit local continuation state"
    );

    let second_dry_run =
        routecodex_v3_runtime::execute_v3_responses_relay_dry_run_runtime_with_local_continuation(
            &manifest(),
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                request_id: "req-stopless-dry-run-3".into(),
                payload: submit_payload,
            },
            &state,
            scope,
            72_000,
        )
        .await;
    assert_eq!(second_dry_run.status, 200);
    let second_provider_request = second_dry_run
        .body
        .get("providerRequest")
        .expect("second dry-run provider request");
    let second_body = second_provider_request
        .get("body")
        .or_else(|| second_provider_request.get("payload"))
        .or(Some(second_provider_request))
        .unwrap();
    assert_eq!(
        second_body["input"], body["input"],
        "provider-request dry-run must be observational only and must not accumulate repeated stopless prompts"
    );
    assert_additional_tools_preserved_without_shape_rebuild(
        second_body,
        original_tools.as_array().unwrap(),
    );
    assert_provider_stopless_guidance(second_body);
    assert_no_stopless_shell_artifacts(second_body);
    assert_eq!(
        state.len().unwrap(),
        1,
        "repeated provider-request dry-run must leave local continuation state unchanged"
    );
}

#[tokio::test]
async fn json_stopless_no_original_tools_injects_single_top_level_tool_before_provider_send() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_stopless_no_original_tools",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"output_text",
                "text":"done {\"stopreason\":0,\"reason\":\"done\",\"has_evidence\":1,\"evidence\":\"no original tools still got stop schema guidance\"}"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-no-original-tools",
        "conversation-stopless-no-original-tools",
        5555,
        "controlled",
    );
    let original_request = json!({
        "model":"client-responses",
        "input":[{"role":"user","content":"Trigger stopless without original tools"}],
        "stream":false
    });

    let response = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-no-original-tools".into(),
            payload: original_request.clone(),
        },
        &transport,
        &state,
        scope,
        72_000,
    )
    .await
    .unwrap();
    match response.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("no-tools terminal stopless turn must be JSON")
        }
    }

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let body = &captures[0];
    assert!(
        original_request.get("tools").is_none(),
        "test setup must represent a real no-original-tools request"
    );
    assert_no_original_tools_injects_single_top_level_reasoning_stop(body);
    assert_provider_stopless_guidance(body);
    assert_no_stopless_shell_artifacts(body);
}

#[tokio::test]
async fn json_stopless_preserves_codex_additional_tools_across_continuation() {
    let original_tools = json!([
        {
            "type":"custom",
            "name":"exec",
            "description":"run javascript",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}
        },
        {
            "type":"function",
            "name":"wait",
            "description":"wait for exec",
            "parameters":{
                "type":"object",
                "additionalProperties":false,
                "properties":{"cell_id":{"type":"string"}},
                "required":["cell_id"]
            },
            "strict":false
        },
        {
            "type":"function",
            "name":"request_user_input",
            "description":"ask user",
            "parameters":{
                "type":"object",
                "additionalProperties":false,
                "properties":{"questions":{"type":"array"}},
                "required":["questions"]
            },
            "strict":false
        }
    ]);
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_stopless_additional_tools_1",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{
                        "type":"output_text",
                        "text":"{\"stopreason\":2,\"reason\":\"round one\",\"current_goal\":\"verify tools\",\"next_step\":\"continue with original tools\"}"
                    }]
                }]
            }),
            json!({
                "id":"resp_stopless_additional_tools_2",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{
                    "type":"output_text",
                    "text":"done {\"stopreason\":0,\"reason\":\"done\",\"has_evidence\":1,\"evidence\":\"additional tools preserved\"}"
                }]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-additional-tools",
        "conversation-stopless-additional-tools",
        5555,
        "controlled",
    );

    let original_request = json!({
        "model":"client-responses",
        "input":[
            {
                "type":"additional_tools",
                "role":"developer",
                "tools": original_tools.clone()
            },
            {"role":"user","content":"Trigger stopless with Codex additional tools"}
        ],
        "stream":false
    });

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-additional-tools-1".into(),
            payload: original_request.clone(),
        },
        &transport,
        &state,
        scope.clone(),
        80_000,
    )
    .await
    .unwrap();
    let first_body = match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("first stopless turn must be JSON"),
    };
    assert_eq!(first_body["status"], "requires_action");
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-additional-tools-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"continue with original tools\"}"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        81_000,
    )
    .await
    .unwrap();
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("second stopless turn must be JSON"),
    }

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    for capture in captures.iter() {
        assert_additional_tools_preserved_without_shape_rebuild(
            capture,
            original_tools.as_array().unwrap(),
        );
        assert_provider_stopless_guidance(capture);
        assert_no_stopless_shell_artifacts(capture);
    }
    assert_eq!(
        captures[1]["input"]
            .as_array()
            .and_then(|items| items.last())
            .and_then(|item| item.get("content"))
            .and_then(Value::as_str),
        Some("continue with original tools")
    );
}

#[tokio::test]
async fn json_stopless_repeat_releases_consumed_context_before_next_projection() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_stopless_repeat_1",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"{\"stopreason\":2,\"reason\":\"round one\",\"next_step\":\"continue round two\"}"}]
                }]
            }),
            json!({
                "id":"resp_stopless_repeat_2",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"{\"stopreason\":2,\"reason\":\"round two\",\"next_step\":\"continue round three\"}"}]
                }]
            }),
            json!({
                "id":"resp_stopless_repeat_3",
                "status":"completed",
                "output":[{"type":"output_text","text":"{\"stopreason\":0,\"reason\":\"done\",\"has_evidence\":1,\"evidence\":\"three rounds completed\"}"}]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-repeat",
        "conversation-stopless-repeat",
        5555,
        "controlled",
    );

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-repeat-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Trigger repeat stopless"}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        40_000,
    )
    .await
    .unwrap();
    let first_observability = first
        .observability
        .as_ref()
        .expect("first repeated stopless turn must expose observability");
    assert_eq!(
        first_observability.finish_reason.as_deref(),
        Some("tool_calls")
    );
    assert!(first_observability.stopless_activation);
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action");
            assert_eq!(
                stopless_projected_call(&body)["call_id"],
                "call_stopless_reasoning"
            );
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("first stopless repeat turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-repeat-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{}'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"{\"next_step\":\"continue round two\"}"
                    }
                ],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        41_000,
    )
    .await
    .unwrap();
    let second_observability = second
        .observability
        .as_ref()
        .expect("second repeated stopless turn must expose observability");
    assert_eq!(
        second_observability.finish_reason.as_deref(),
        Some("tool_calls")
    );
    assert!(second_observability.stopless_activation);
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action");
            assert_eq!(
                stopless_projected_call(&body)["call_id"],
                "call_stopless_reasoning"
            );
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("second stopless repeat turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let third = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-repeat-3".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"next_step\":\"continue round three\"}"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        42_000,
    )
    .await
    .unwrap();
    match third.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("third stopless repeat turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 3);
    assert_eq!(
        captures[1]["input"],
        json!([{"role":"user","content":"continue round two"}])
    );
    for capture in captures.iter() {
        assert_provider_stopless_guidance(capture);
        assert_no_stopless_shell_artifacts(capture);
    }
}

#[tokio::test]
async fn json_stopless_no_schema_stops_after_three_cross_request_rounds() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "object":"response",
                "id":"resp_stopless_no_schema_1",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"missing schema round one"}]
                }]
            }),
            json!({
                "object":"response",
                "id":"resp_stopless_no_schema_2",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"missing schema round two"}]
                }]
            }),
            json!({
                "object":"response",
                "id":"resp_stopless_no_schema_3",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"missing schema round three"}]
                }]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-no-schema",
        "conversation-stopless-no-schema",
        5555,
        "controlled",
    );

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-no-schema-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Trigger missing schema"}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        50_000,
    )
    .await
    .unwrap();
    let first_body = match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("first no_schema turn must be JSON"),
    };
    assert_eq!(first_body["status"], "requires_action");
    assert_eq!(
        stopless_cli_input_from_client_body(&first_body)["repeatCount"],
        json!(1)
    );
    assert!(first.observability.unwrap().stopless_activation);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-no-schema-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\"]},\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":1,\"maxRepeats\":3}}"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        51_000,
    )
    .await
    .unwrap();
    let second_body = match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("second no_schema turn must be JSON"),
    };
    assert_eq!(second_body["status"], "requires_action");
    assert_eq!(
        stopless_cli_input_from_client_body(&second_body)["repeatCount"],
        json!(2)
    );
    assert!(second.observability.unwrap().stopless_activation);

    let third = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-no-schema-3".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\"]},\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":2,\"maxRepeats\":3}}"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        52_000,
    )
    .await
    .unwrap();
    let third_observability = third.observability.as_ref().unwrap();
    assert!(
        !third_observability.stopless_activation,
        "third consecutive no_schema must not project another reasoningStop"
    );
    match third.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            assert!(serde_json::to_string(&body)
                .unwrap()
                .contains("missing schema round three"));
            assert!(!serde_json::to_string(&body)
                .unwrap()
                .contains("call_stopless_reasoning"));
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("third no_schema turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 3);
    let round2_input = captures[1]["input"].as_array().unwrap();
    assert_eq!(
        round2_input[0],
        json!({"role":"user","content":"Trigger missing schema"})
    );
    assert_no_schema_feedback_prompt(&round2_input[1]);
    let round3_input = captures[2]["input"].as_array().unwrap();
    assert_eq!(
        round3_input[0],
        json!({"role":"user","content":"Trigger missing schema"})
    );
    assert_no_schema_feedback_prompt(&round3_input[1]);
    assert_no_schema_feedback_prompt(&round3_input[2]);
    for capture in captures.iter() {
        assert_provider_stopless_guidance(capture);
        assert_no_stopless_shell_artifacts(capture);
    }
}

#[tokio::test]
async fn json_stopless_no_schema_budget_exhaustion_ignores_trailing_tool_errors() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "object":"response",
            "id":"resp_stopless_no_schema_after_tool_errors",
            "status":"completed",
            "output":[{
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"missing schema after bad tool outputs"}]
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-tool-error-tail",
        "conversation-stopless-tool-error-tail",
        5555,
        "controlled",
    );

    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-tool-error-tail".into(),
            payload: json!({
                "model":"client-responses",
                "input":[
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":2,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '2' --max-repeats '3'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: stopless\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":2,\"maxRepeats\":3}}\n"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_auto_1",
                        "name":"exec_command",
                        "arguments":"{}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_auto_1",
                        "output":"failed to parse function arguments: missing field `cmd` at line 1 column 2"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_auto_2",
                        "name":"tools",
                        "arguments":"{}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_auto_2",
                        "output":"unsupported call: tools"
                    },
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":1,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '1' --max-repeats '3'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: poisoned-r1\nOutput:\n{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":1,\"maxRepeats\":3}}\n"
                    }
                ],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        52_500,
    )
    .await
    .unwrap();

    let observability = output.observability.as_ref().unwrap();
    assert!(
        !observability.stopless_activation,
        "repeatCount=2 plus another no_schema must exhaust instead of projecting repeatCount=1"
    );
    match output.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            let body_text = serde_json::to_string(&body).unwrap();
            assert!(body_text.contains("missing schema after bad tool outputs"));
            assert!(!body_text.contains("call_stopless_reasoning"));
            assert!(!body_text.contains("routecodex hook run reasoningStop"));
        }
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("tool-error-tail no_schema turn must be JSON")
        }
    }

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let provider_wire = serde_json::to_string(&captures[0]).unwrap();
    assert!(provider_wire.contains("stopreason"));
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID: stopless",
        "Chunk ID: poisoned-r1",
        "failed to parse function arguments",
        "unsupported call: tools",
        "call_auto_1",
        "call_auto_2",
    ] {
        assert!(
            !provider_wire.contains(forbidden),
            "provider request leaked stopless artifact or client tool error: {forbidden}"
        );
    }
}

#[tokio::test]
async fn json_stopless_budget_exhausted_provider_tool_call_returns_requires_action() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "object":"response",
            "id":"resp_stopless_budget_provider_tool_call",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{
                "type":"function_call",
                "id":"fc_auto_1",
                "call_id":"call_auto_1",
                "name":"exec_command",
                "arguments":"{}"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-budget-tool-call",
        "conversation-stopless-budget-tool-call",
        5555,
        "controlled",
    );

    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-budget-tool-call".into(),
            payload: json!({
                "model":"client-responses",
                "input":[
                    {
                        "type":"function_call",
                        "call_id":"call_stopless_reasoning",
                        "name":"exec_command",
                        "arguments":"{\"cmd\":\"routecodex hook run reasoningStop --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":2,\\\"maxRepeats\\\":3,\\\"triggerHint\\\":\\\"no_schema\\\"}' --repeat-count '2' --max-repeats '3'\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_stopless_reasoning",
                        "output":"Chunk ID: stopless-budget\nOutput:\n{\"ok\":true,\"repeatCount\":2,\"maxRepeats\":3,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_missing\",\"missingFields\":[\"stopreason\"]},\"input\":{\"triggerHint\":\"no_schema\",\"repeatCount\":2,\"maxRepeats\":3}}\n"
                    }
                ],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        53_000,
    )
    .await
    .unwrap();

    let observability = output.observability.as_ref().unwrap();
    assert!(
        !observability.stopless_activation,
        "budget exhausted must not project another stopless CLI"
    );
    match output.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(
                body["status"], "requires_action",
                "client semantic must not expose provider raw completed+tool_call"
            );
            assert_eq!(body["finish_reason"], "tool_calls");
            assert_eq!(body["output"][0]["type"], "function_call");
            assert_eq!(body["output"][0]["call_id"], "call_auto_1");
            let body_text = serde_json::to_string(&body).unwrap();
            assert!(!body_text.contains("call_stopless_reasoning"));
            assert!(!body_text.contains("routecodex hook run reasoningStop"));
        }
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("budget-exhausted provider tool-call turn must be JSON")
        }
    }
}

#[tokio::test]
async fn json_stopless_invalid_schema_stops_after_three_cross_request_rounds() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "object":"response",
                "id":"resp_stopless_invalid_schema_1",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"{\"stopreason\":\"bad\",\"reason\":\"not numeric\"}"}]
                }]
            }),
            json!({
                "object":"response",
                "id":"resp_stopless_invalid_schema_2",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"{\"stopreason\":\"bad\",\"reason\":\"not numeric\"}"}]
                }]
            }),
            json!({
                "object":"response",
                "id":"resp_stopless_invalid_schema_3",
                "status":"completed",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"{\"stopreason\":\"bad\",\"reason\":\"not numeric\"}"}]
                }]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-invalid-schema",
        "conversation-stopless-invalid-schema",
        5555,
        "controlled",
    );

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-invalid-schema-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Trigger invalid schema"}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        53_000,
    )
    .await
    .unwrap();
    let first_body = match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("first invalid_schema turn must be JSON"),
    };
    assert_eq!(first_body["status"], "requires_action");
    assert_eq!(
        stopless_cli_input_from_client_body(&first_body)["repeatCount"],
        json!(1)
    );
    assert!(first.observability.unwrap().stopless_activation);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-invalid-schema-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":1,\"maxRepeats\":3,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_stopreason_missing_or_non_numeric\",\"missingFields\":[\"stopreason\"]},\"input\":{\"triggerHint\":\"invalid_schema\",\"repeatCount\":1,\"maxRepeats\":3}}"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        54_000,
    )
    .await
    .unwrap();
    let second_body = match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("second invalid_schema turn must be JSON"),
    };
    assert_eq!(second_body["status"], "requires_action");
    assert_eq!(
        stopless_cli_input_from_client_body(&second_body)["repeatCount"],
        json!(2)
    );
    assert!(second.observability.unwrap().stopless_activation);

    let third = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-invalid-schema-3".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":"{\"ok\":true,\"continuationPrompt\":\"继续。\",\"repeatCount\":2,\"maxRepeats\":3,\"schemaFeedback\":{\"reasonCode\":\"stop_schema_stopreason_missing_or_non_numeric\",\"missingFields\":[\"stopreason\"]},\"input\":{\"triggerHint\":\"invalid_schema\",\"repeatCount\":2,\"maxRepeats\":3}}"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        55_000,
    )
    .await
    .unwrap();
    let third_observability = third.observability.as_ref().unwrap();
    assert!(
        !third_observability.stopless_activation,
        "third consecutive invalid_schema must not project another reasoningStop"
    );
    match third.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            assert!(serde_json::to_string(&body)
                .unwrap()
                .contains("not numeric"));
            assert!(!serde_json::to_string(&body)
                .unwrap()
                .contains("call_stopless_reasoning"));
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("third invalid_schema turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 3);
    let round2_input = captures[1]["input"].as_array().unwrap();
    assert_eq!(
        round2_input[0],
        json!({"role":"user","content":"Trigger invalid schema"})
    );
    assert_invalid_schema_feedback_prompt(&round2_input[1]);
    let round3_input = captures[2]["input"].as_array().unwrap();
    assert_eq!(
        round3_input[0],
        json!({"role":"user","content":"Trigger invalid schema"})
    );
    assert_invalid_schema_feedback_prompt(&round3_input[1]);
    assert_invalid_schema_feedback_prompt(&round3_input[2]);
    for capture in captures.iter() {
        let provider_wire = serde_json::to_string(capture).unwrap();
        assert!(provider_wire.contains("stopreason"));
        assert_provider_stopless_guidance(capture);
        for forbidden in [
            "call_stopless_reasoning",
            "function_call_output",
            "routecodex hook run reasoningStop",
        ] {
            assert!(
                !provider_wire.contains(forbidden),
                "provider payload leaked stopless artifact: {forbidden}"
            );
        }
    }
}

#[tokio::test]
async fn sse_runtime_runs_stopless_through_json_hub_pipeline_before_client_sse() {
    let transport = StoplessSseTransport {
        captures: Mutex::new(Vec::new()),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-sse",
        "conversation-stopless-sse",
        5555,
        "controlled",
    );

    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-stopless-sse-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":"Trigger stopless over SSE",
                "stream":true
            }),
        },
        &transport,
        &state,
        scope,
        32_000,
    )
    .await
    .unwrap();

    let output_observability = output
        .observability
        .as_ref()
        .expect("SSE stopless turn must expose observability");
    assert_eq!(
        output_observability.response_status.as_deref(),
        Some("requires_action")
    );
    assert_eq!(output_observability.finish_reason.as_deref(), Some("stop"));
    assert!(output_observability.stopless_activation);
    let stream_observation = output
        .stream_observation
        .clone()
        .expect("SSE stopless output must expose stream observability");
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("projected stopless SSE chunk"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(
                text.contains("event: response.output_item.done"),
                "Responses Relay client SSE must encode the Hub-finalized stopless tool item: {text}"
            );
            assert!(
                text.contains("event: response.requires_action"),
                "Responses Relay client SSE must transport the Hub-finalized requires_action frame: {text}"
            );
            assert!(
                !text.contains("event: response.completed"),
                "Responses Relay client SSE must not relabel Hub-finalized requires_action as completed: {text}"
            );
            assert!(text.contains("\"status\":\"requires_action\""));
            assert!(text.contains("\"call_id\":\"call_stopless_reasoning\""));
            assert!(text.contains("routecodex hook run reasoningStop"));
            assert!(text.contains("[DONE]"));
            assert!(
                !text.contains("event: response.output_text.delta"),
                "Relay client SSE transport must not raw-pass provider event payloads around Hub: {text}"
            );
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("SSE request must project SSE stream"),
    }
    assert_eq!(
        state.len().unwrap(),
        1,
        "SSE Relay must save the Hub-finalized stopless continuation payload at Resp04"
    );
    let snapshot = stream_observation.snapshot().unwrap();
    assert_eq!(snapshot.response_status.as_deref(), Some("requires_action"));
    assert_eq!(snapshot.finish_reason.as_deref(), Some("stop"));
}

#[tokio::test]
async fn sse_runtime_runs_apply_patch_through_json_hub_pipeline_before_client_sse() {
    let transport = ApplyPatchSseTransport {
        captures: Mutex::new(Vec::new()),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-apply-patch-sse",
        "conversation-apply-patch-sse",
        5555,
        "controlled",
    );

    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-apply-patch-sse-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":"Patch a file over SSE",
                "tools":[{"type":"custom","name":"apply_patch","format":"freeform"}],
                "stream":true
            }),
        },
        &transport,
        &state,
        scope,
        33_000,
    )
    .await
    .unwrap();

    let observability = output
        .observability
        .as_ref()
        .expect("SSE apply_patch turn must expose observability");
    assert_eq!(
        observability.response_status.as_deref(),
        Some("requires_action")
    );
    assert_eq!(observability.finish_reason.as_deref(), Some("tool_calls"));
    let stream_observation = output
        .stream_observation
        .clone()
        .expect("SSE apply_patch output must expose stream observability");
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("projected apply_patch SSE chunk"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(
                text.contains("event: response.output_item.done"),
                "Responses Relay client SSE must encode the Hub-finalized apply_patch tool item: {text}"
            );
            assert!(
                text.contains("event: response.requires_action"),
                "Responses Relay client SSE must transport the Hub-finalized requires_action frame: {text}"
            );
            assert!(
                !text.contains("event: response.completed"),
                "Responses Relay client SSE must not relabel Hub-finalized tool-call continuation as completed: {text}"
            );
            assert!(text.contains("\"status\":\"requires_action\""));
            assert!(text.contains("\"type\":\"custom_tool_call\""));
            assert!(text.contains("\"name\":\"apply_patch\""));
            assert!(text.contains("\"call_id\":\"call_apply_patch_sse\""));
            assert!(text.contains("*** Begin Patch"));
            assert!(
                !text.contains("event: response.function_call_arguments.done"),
                "Relay client SSE transport must not raw-pass provider argument event payloads around Hub: {text}"
            );
            assert!(text.contains("[DONE]"));
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("SSE request must project SSE stream"),
    }
    assert_eq!(
        state.len().unwrap(),
        1,
        "SSE Relay must save the Hub-finalized apply_patch continuation payload at Resp04"
    );
    let snapshot = stream_observation.snapshot().unwrap();
    assert_eq!(snapshot.response_status.as_deref(), Some("requires_action"));
    assert_eq!(snapshot.finish_reason.as_deref(), Some("tool_calls"));
}

#[tokio::test]
async fn json_two_turn_restores_tool_call_pairs_output_and_preserves_tools() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_local_1",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_local_1",
                    "name":"lookup",
                    "arguments":"{\"q\":\"alpha\"}"
                }]
            }),
            json!({
                "id":"resp_local_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"alpha result"}]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-local",
        "conversation-local",
        5555,
        "controlled",
    );
    let second_tools = json!([{
        "type":"function",
        "name":"lookup",
        "parameters":{"type":"object","properties":{"q":{"type":"string"}}}
    }]);

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-local-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Lookup alpha"}],
                "tools":second_tools.clone(),
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        1_000,
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "requires_action"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("first turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-local-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_local_1",
                    "output":"alpha"
                }],
                "tools":second_tools.clone(),
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        2_000,
    )
    .await
    .unwrap();
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("second turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(
        captures[1]["input"],
        json!([
            {"role":"user","content":"Lookup alpha"},
            {
                "type":"function_call",
                "call_id":"call_local_1",
                "name":"lookup",
                "arguments":"{\"q\":\"alpha\"}"
            },
            {
                "type":"function_call_output",
                "call_id":"call_local_1",
                "output":"alpha"
            }
        ])
    );
    assert_original_tools_preserved(&captures[1], second_tools.as_array().unwrap());
    assert_provider_stopless_guidance(&captures[1]);
    assert_no_stopless_shell_artifacts(&captures[1]);
    let provider_wire = serde_json::to_string(&captures[1]).unwrap();
    for forbidden in [
        "session-local",
        "conversation-local",
        "routecodex_local",
        "continuation_owner",
        "metadata_center",
        "store_key",
    ] {
        assert!(
            !provider_wire.contains(forbidden),
            "provider payload leaked {forbidden}"
        );
    }
}

#[tokio::test]
async fn json_two_turn_preserves_responses_additional_tools_surface_and_tool_result_pairs() {
    let original_tools = json!([{
        "type":"function",
        "name":"lookup",
        "description":"lookup beta",
        "parameters":{"type":"object","properties":{"q":{"type":"string"}}},
        "strict":false
    }]);
    let original_additional_tools_item = json!({
        "type":"additional_tools",
        "role":"developer",
        "tools": original_tools.clone()
    });
    let original_user_item = json!({"role":"user","content":"Lookup beta"});
    let provider_function_call = json!({
        "type":"function_call",
        "call_id":"call_lookup_additional",
        "name":"lookup",
        "arguments":"{\"q\":\"beta\"}"
    });
    let provider_function_output = json!({
        "type":"function_call_output",
        "call_id":"call_lookup_additional",
        "output":"beta"
    });
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_local_additional_tools_1",
                "status":"requires_action",
                "output":[provider_function_call.clone()]
            }),
            json!({
                "id":"resp_local_additional_tools_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"beta result"}]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-additional-tools-normal",
        "conversation-additional-tools-normal",
        5555,
        "controlled",
    );
    let original_request = json!({
        "model":"client-responses",
        "input":[original_additional_tools_item.clone(), original_user_item.clone()],
        "stream":false
    });

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-additional-tools-normal-1".into(),
            payload: original_request.clone(),
        },
        &transport,
        &state,
        scope.clone(),
        2_100,
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "requires_action"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("first additional-tools turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-additional-tools-normal-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[provider_function_output.clone()],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        2_200,
    )
    .await
    .unwrap();
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("second additional-tools turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    for capture in captures.iter() {
        assert_additional_tools_preserved_without_shape_rebuild(
            capture,
            original_tools.as_array().unwrap(),
        );
        assert_provider_stopless_guidance(capture);
        assert_no_stopless_shell_artifacts(capture);
    }
    assert!(
        captures[0].get("tools").is_none(),
        "round-1 provider request must not synthesize a sibling top-level tools surface: {}",
        captures[0]
    );
    assert!(
        captures[1].get("tools").is_none(),
        "round-2 provider request must not synthesize a sibling top-level tools surface: {}",
        captures[1]
    );
    let round2_input = captures[1]["input"]
        .as_array()
        .expect("round-2 provider input must be array");
    assert_eq!(
        round2_input.len(),
        4,
        "round-2 provider input must be original additional_tools + original user + restored tool call + current tool output: {round2_input:?}"
    );
    assert_eq!(
        round2_input[0]["type"], original_additional_tools_item["type"],
        "original additional_tools item must stay at the original input path"
    );
    assert_eq!(
        round2_input[0]["role"], original_additional_tools_item["role"],
        "original additional_tools role must stay at the original input path"
    );
    for (index, expected_tool) in original_tools.as_array().unwrap().iter().enumerate() {
        assert_eq!(
            &round2_input[0]["tools"][index], expected_tool,
            "round-2 provider request changed original input[0].tools[{index}]"
        );
    }
    assert_eq!(round2_input[1], original_user_item);
    assert_eq!(round2_input[2], provider_function_call);
    assert_eq!(round2_input[3], provider_function_output);
    let provider_wire = serde_json::to_string(&captures[1]).unwrap();
    for forbidden in [
        "session-additional-tools-normal",
        "conversation-additional-tools-normal",
        "routecodex_local",
        "continuation_owner",
        "metadata_center",
        "store_key",
    ] {
        assert!(
            !provider_wire.contains(forbidden),
            "provider payload leaked {forbidden}"
        );
    }
}

#[tokio::test]
async fn json_two_turn_apply_patch_uses_freeform_projection_and_error_feedback() {
    let patch = "*** Begin Patch\n*** Update File: src/main.rs\n@@\n-old\n+new\n*** End Patch";
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_apply_patch_1",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_apply_patch_freeform",
                    "name":"apply_patch",
                    "arguments": serde_json::to_string(&json!({"patch": patch})).unwrap()
                }]
            }),
            json!({
                "id":"resp_apply_patch_2",
                "status":"completed",
                "output":[{"type":"output_text","text":"retry received"}]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-apply-patch",
        "conversation-apply-patch",
        5555,
        "controlled",
    );

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-apply-patch-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{"role":"user","content":"Patch a file"}],
                "tools":[{"type":"custom","name":"apply_patch","format":"freeform"}],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        20_000,
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action");
            assert_eq!(body["output"][0]["type"], "custom_tool_call");
            assert_eq!(body["output"][0]["name"], "apply_patch");
            assert_eq!(body["output"][0]["call_id"], "call_apply_patch_freeform");
            assert_eq!(body["output"][0]["input"], patch);
            assert!(body["output"][0].get("arguments").is_none());
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("first turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-apply-patch-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"custom_tool_call_output",
                    "call_id":"call_apply_patch_freeform",
                    "output":"apply_patch verification failed: invalid patch for /tmp/codex-patch-test/new.txt"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        21_000,
    )
    .await
    .unwrap();
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("second turn must be JSON"),
    }
    assert!(state.is_empty().unwrap());

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[1]["input"][0]["role"], "user");
    assert_eq!(captures[1]["input"][0]["content"], "Patch a file");
    assert_eq!(captures[1]["input"][1]["type"], "custom_tool_call");
    assert_eq!(captures[1]["input"][1]["name"], "apply_patch");
    assert_eq!(captures[1]["input"][1]["input"], patch);
    assert_eq!(captures[1]["input"][2]["type"], "custom_tool_call_output");
    let feedback = captures[1]["input"][2]["output"].as_str().unwrap();
    assert!(feedback.starts_with("APPLY_PATCH_ERROR: apply_patch did not apply"));
    assert!(feedback.contains("Retry with apply_patch only"));
    assert!(!feedback.contains("/tmp/codex-patch-test"));
}

#[tokio::test]
async fn wrong_tool_output_id_fails_before_provider_send_and_keeps_saved_context() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_local_wrong_1",
            "status":"requires_action",
            "output":[{
                "type":"function_call",
                "call_id":"call_saved",
                "name":"lookup",
                "arguments":"{}"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-wrong",
        "conversation-wrong",
        5555,
        "controlled",
    );
    execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-wrong-1".into(),
            payload: json!({
                "model":"client-responses",
                "input":"save context",
                "stream":false
            }),
        },
        &transport,
        &state,
        scope.clone(),
        10_000,
    )
    .await
    .unwrap();
    assert_eq!(state.len().unwrap(), 1);

    let error = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-wrong-2".into(),
            payload: json!({
                "model":"client-responses",
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_missing",
                    "output":"wrong"
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        11_000,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("not found"));
    assert_eq!(transport.captures.lock().unwrap().len(), 1);
    assert_eq!(state.len().unwrap(), 1);
}

#[tokio::test]
async fn full_history_paired_tool_output_does_not_require_local_restore() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_full_history_2",
            "status":"completed",
            "output":[{"type":"output_text","text":"full history ok"}]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "request:req-full-history",
        "request:req-full-history",
        5555,
        "controlled",
    );

    let response = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-full-history".into(),
            payload: json!({
                "model":"client-responses",
                "previous_response_id":"1a3e546c-0a32-4667-933c-03f88aafc05c",
                "input":[
                    {"role":"user","content":"Lookup alpha"},
                    {
                        "type":"function_call",
                        "call_id":"call_full_history",
                        "name":"lookup",
                        "arguments":"{\"q\":\"alpha\"}"
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_full_history",
                        "output":"alpha"
                    }
                ],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        20_000,
    )
    .await
    .unwrap();
    match response.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("full-history replay must be JSON"),
    }
    assert!(state.is_empty().unwrap());
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_eq!(captures[0]["input"][1]["call_id"], "call_full_history");
    assert_eq!(captures[0]["input"][2]["call_id"], "call_full_history");
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[providers.controlled]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.controlled.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning", "streaming"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
