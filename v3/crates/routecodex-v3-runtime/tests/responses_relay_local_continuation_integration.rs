use async_trait::async_trait;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control,
    execute_v3_responses_relay_runtime_with_local_continuation,
    execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control,
    execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control,
    V3ResponsesRelayClientBody, V3ResponsesRelayLocalContinuationScope,
    V3ResponsesRelayLocalContinuationState, V3ResponsesRelayLocalStoplessControlInput,
    V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayStoplessControlScope, V3ResponsesRelayStoplessControlState,
    V3StoplessCenterPhase,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

struct SequentialJsonTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
}

struct ProviderProjectionJsonTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
}

struct ProviderProjectionOpenAiChatSseTransport {
    captures: Mutex<Vec<Value>>,
}

struct ProviderProjectionFirstSseThenJsonTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
}

struct StoplessSseTransport {
    captures: Mutex<Vec<Value>>,
}

struct StoplessInFlightProbeTransport {
    captures: Mutex<Vec<Value>>,
    responses: Mutex<VecDeque<Value>>,
    stopless_control: Arc<V3ResponsesRelayStoplessControlState>,
    stopless_scope: V3ResponsesRelayStoplessControlScope,
}

struct ApplyPatchSseTransport {
    captures: Mutex<Vec<Value>>,
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
        .or_else(|| tool.get("custom").and_then(|custom| custom.get("name")))
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
        0,
        "provider request must not expose internal reasoningStop tools, got {names:?}"
    );
    let serialized = serde_json::to_string(body).unwrap();
    for forbidden in [
        "当前轮推进准则",
        "reasoningStop",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "<rcc_stop_schema>",
        "schemaFeedback",
        "repeatCount",
        "maxRepeats",
        "triggerHint",
        "next_step",
        "stop schema",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "provider request leaked stopless control token {forbidden}: {serialized}"
        );
    }
}

fn provider_system_input_text(item: &Value) -> Option<&str> {
    if item.get("type").and_then(Value::as_str) != Some("message")
        || item.get("role").and_then(Value::as_str) != Some("system")
    {
        return None;
    }
    match item.get("content") {
        Some(Value::String(text)) => Some(text.as_str()),
        Some(Value::Array(parts)) => parts
            .iter()
            .find_map(|part| part.get("text").and_then(Value::as_str)),
        _ => None,
    }
}

fn provider_logical_input_without_stopless_system_prefix(input: &Value) -> Vec<Value> {
    let items = input
        .as_array()
        .expect("provider input must be array for logical input assertion");
    let skip = items.first().is_some_and(|item| {
        provider_system_input_text(item).is_some_and(|text| {
            text.contains("当前轮推进准则") || text.contains("[Codex Tool Guidance]")
        })
    });
    items.iter().skip(usize::from(skip)).cloned().collect()
}

fn assert_full_stopless_continuation_prompt(prompt: &str) {
    for required in [
        "继续当前目标",
        "基于已经恢复的完整上下文",
        "上一轮明确写出的下一步",
        "已有结论",
        "未完成事项",
        "继续执行",
        "本轮必须调用最相关工具",
        "不要只总结",
        "目标确实完成并有证据",
        "reasoningStop",
        "阻塞",
        "needs_user_input",
        "既未完成也未阻塞，继续工作",
    ] {
        assert!(
            prompt.contains(required),
            "stopless continuation prompt missing transparent guideline token {required}: {prompt}"
        );
    }
    for forbidden in [
        "no-op",
        "CLI",
        "client tool round",
        "客户端工具轮",
        "routecodex hook run reasoningStop",
        "上一轮 reasoningStop CLI",
        "不是工具结果",
        "finish_reason=stop",
        "RouteCodex stopless continuation",
    ] {
        assert!(
            !prompt.contains(forbidden),
            "provider-visible continuation prompt leaked black-box bridge mechanism {forbidden}: {prompt}"
        );
    }
}

fn assert_full_stopless_continuation_item(item: &Value) {
    assert_eq!(item.get("role").and_then(Value::as_str), Some("user"));
    let content = item
        .get("content")
        .and_then(|content| {
            content.as_str().map(str::to_string).or_else(|| {
                content.as_array().and_then(|parts| {
                    parts.iter().find_map(|part| {
                        part.get("text")
                            .or_else(|| part.get("content"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                })
            })
        })
        .expect("stopless continuation user content");
    assert_full_stopless_continuation_prompt(&content);
}

fn assert_original_tools_preserved(body: &Value, expected_original_tools: &[Value]) {
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .expect("original request path $.tools must still exist before provider send");
    assert_eq!(
        tools.len(),
        expected_original_tools.len(),
        "original request path $.tools must preserve only original tools; stopless control tools are side-channel-only: {tools:?}"
    );
    for (index, expected) in expected_original_tools.iter().enumerate() {
        assert_eq!(
            &tools[index], expected,
            "original $.tools[{index}] changed before provider send"
        );
    }
}

fn strip_generated_responses_item_ids(mut items: Vec<Value>) -> Vec<Value> {
    for item in &mut items {
        if let Some(object) = item.as_object_mut() {
            object.remove("id");
        }
    }
    items
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
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .expect("ReqInbound Chat normalization projects additional_tools onto the Chat/top-level tool surface");
    assert_eq!(
        tools.len(),
        expected_original_tools.len(),
        "provider request tools must preserve original declarations without appending stopless control tools: {tools:?}"
    );
    for (index, expected) in expected_original_tools.iter().enumerate() {
        let mut actual = tools[index].clone();
        let mut expected = expected.clone();
        if actual.get("strict").is_none() && expected.get("strict") == Some(&json!(false)) {
            expected.as_object_mut().unwrap().remove("strict");
        }
        if expected.get("parameters").is_none()
            && actual
                .get("parameters")
                .and_then(Value::as_object)
                .is_some_and(|parameters| {
                    parameters.get("type") == Some(&json!("object"))
                        && parameters.get("additionalProperties") == Some(&json!(true))
                        && parameters
                            .get("properties")
                            .and_then(Value::as_object)
                            .is_some_and(|properties| properties.is_empty())
                })
        {
            actual.as_object_mut().unwrap().remove("parameters");
        }
        assert_eq!(
            actual, expected,
            "original tool declaration {index} changed before provider send"
        );
    }
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

fn provider_projection_body(projection: &Value) -> &Value {
    projection
        .get("body")
        .expect("provider projection must expose transport body")
}

fn assert_provider_chat_stopless_guidance(body: &Value) {
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .expect("OpenAI Chat provider body must expose provider-wire top-level tools");
    let names: Vec<_> = tools.iter().filter_map(tool_name).collect();
    assert_eq!(
        names,
        vec!["exec", "wait", "request_user_input"],
        "OpenAI Chat provider tools must preserve original tools without appending stopless control tools: {tools:?}"
    );
    let exec_tool = tools
        .iter()
        .find(|tool| tool_name(tool) == Some("exec"))
        .expect("exec tool");
    assert_eq!(
        exec_tool.get("type").and_then(Value::as_str),
        Some("custom"),
        "Responses custom exec must remain a native OpenAI Chat custom tool: {exec_tool}"
    );
    assert_eq!(
        exec_tool.pointer("/custom/format/type"),
        Some(&json!("grammar")),
        "Responses custom exec grammar format must remain target-native: {exec_tool}"
    );
    let exec_description = exec_tool
        .pointer("/custom/description")
        .and_then(Value::as_str)
        .expect("OpenAI Chat exec description");
    assert!(exec_description.contains("Execute freeform script"));
    assert_eq!(
        exec_tool.pointer("/custom/format/grammar/syntax"),
        Some(&json!("lark"))
    );
    let serialized = serde_json::to_string(body).unwrap();
    for forbidden in [
        "当前轮推进准则",
        "reasoningStop",
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "<rcc_stop_schema>",
        "schemaFeedback",
        "repeatCount",
        "maxRepeats",
        "triggerHint",
        "next_step",
        "stop schema",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "OpenAI Chat provider body leaked stopless control token {forbidden}: {serialized}"
        );
    }
}

fn assert_openai_chat_wire_tools_semantically_preserve_responses_tools(
    body: &Value,
    expected_original_tools: &[Value],
) {
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .expect("OpenAI Chat provider body must expose provider-wire top-level tools");
    assert_eq!(
        tools.len(),
        expected_original_tools.len(),
        "OpenAI Chat provider tools must preserve original tools without adding stopless control tools: {tools:?}"
    );
    for (index, expected) in expected_original_tools.iter().enumerate() {
        let actual = &tools[index];
        assert_eq!(
            tool_name(actual),
            expected.get("name").and_then(Value::as_str),
            "OpenAI Chat tool[{index}] name changed: actual={actual} expected={expected}"
        );
        if expected.get("type").and_then(Value::as_str) == Some("function") {
            let function = actual
                .get("function")
                .and_then(Value::as_object)
                .expect("OpenAI Chat function tool wrapper");
            assert_eq!(
                function.get("description"),
                expected.get("description"),
                "OpenAI Chat function tool[{index}] description changed: actual={actual} expected={expected}"
            );
            assert_eq!(
                function.get("parameters"),
                expected.get("parameters"),
                "OpenAI Chat function tool[{index}] parameters changed: actual={actual} expected={expected}"
            );
            assert_eq!(
                function.get("strict"),
                expected.get("strict"),
                "OpenAI Chat function tool[{index}] strict flag changed: actual={actual} expected={expected}"
            );
        } else {
            assert_eq!(actual.get("type").and_then(Value::as_str), Some("custom"));
            let custom = actual
                .get("custom")
                .and_then(Value::as_object)
                .expect("OpenAI Chat custom tool wrapper");
            let description = custom
                .get("description")
                .and_then(Value::as_str)
                .expect("custom tool description");
            let expected_description = expected
                .get("description")
                .and_then(Value::as_str)
                .expect("custom tool description");
            assert!(
                description.contains(expected_description),
                "OpenAI Chat custom tool[{index}] must preserve original description: actual={actual} expected={expected}"
            );
            let expected_format = expected
                .get("format")
                .and_then(Value::as_object)
                .expect("Responses custom format");
            assert_eq!(
                custom
                    .get("format")
                    .and_then(Value::as_object)
                    .and_then(|format| format.get("type")),
                expected_format.get("type"),
                "custom format type changed: actual={actual} expected={expected}"
            );
            if expected_format.get("type").and_then(Value::as_str) == Some("grammar") {
                assert_eq!(
                    custom
                        .get("format")
                        .and_then(Value::as_object)
                        .and_then(|format| format.get("grammar"))
                        .and_then(Value::as_object)
                        .and_then(|grammar| grammar.get("syntax")),
                    expected_format.get("syntax"),
                    "custom grammar syntax changed: actual={actual} expected={expected}"
                );
                assert_eq!(
                    custom
                        .get("format")
                        .and_then(Value::as_object)
                        .and_then(|format| format.get("grammar"))
                        .and_then(Value::as_object)
                        .and_then(|grammar| grammar.get("definition")),
                    expected_format.get("definition"),
                    "custom grammar definition changed: actual={actual} expected={expected}"
                );
            }
        }
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
impl ResponsesTransport for StoplessInFlightProbeTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let send_index = {
            let mut captures = self.captures.lock().unwrap();
            captures.push(request.body().clone());
            captures.len()
        };
        if send_index == 2 {
            let stored = self
                .stopless_control
                .load_for_scope(&self.stopless_scope)
                .unwrap()
                .expect("Req04 must persist ProviderTurnInFlight before provider send");
            assert_eq!(
                stored.phase(),
                V3StoplessCenterPhase::ProviderTurnInFlight,
                "StoplessCenter must leave stale CliNoopProjected and enter ProviderTurnInFlight before provider wire"
            );
        }
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
impl ResponsesTransport for ProviderProjectionJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push(request.redacted_provider_request_projection());
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
impl ResponsesTransport for ProviderProjectionFirstSseThenJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push(request.redacted_provider_request_projection());
        let response = self.responses.lock().unwrap().pop_front().unwrap();
        if response.get("object").and_then(Value::as_str) == Some("chat.completion.chunk") {
            let stream = futures_util::stream::iter([
                Ok(format!("data: {response}\n\n").into_bytes()),
                Ok(b"data: [DONE]\n\n".to_vec()),
            ]);
            return Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(stream),
            ));
        }
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
impl ResponsesTransport for ProviderProjectionOpenAiChatSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push(request.redacted_provider_request_projection());
        let first = json!({
            "id":"chatcmpl-stopless-wire-sse",
            "object":"chat.completion.chunk",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "delta":{
                    "role":"assistant",
                    "reasoning_content":"Need chat wire SSE before tool."
                },
                "finish_reason":null
            }]
        });
        let second = json!({
            "id":"chatcmpl-stopless-wire-sse",
            "object":"chat.completion.chunk",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "delta":{"tool_calls":[{
                    "index":0,
                    "id":"call_exec_sse",
                    "type":"function",
                    "function":{
                        "name":"exec",
                        "arguments":"{\"input\":\"text('chat sse ok')\"}"
                    }
                }]},
                "finish_reason":"tool_calls"
            }],
            "usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}
        });
        let empty_tail_sentinel = json!({
            "id":"",
            "object":"",
            "created":0,
            "model":"chat-wire-model",
            "system_fingerprint":null,
            "choices":[],
            "usage":null
        });
        let stream = futures_util::stream::iter([
            Ok(format!("data: {first}\n\n").into_bytes()),
            Ok(format!("data: {second}\n\n").into_bytes()),
            Ok(format!("data: {empty_tail_sentinel}\n\n").into_bytes()),
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
async fn json_stopless_center_persists_without_local_continuation_store() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_stopless_center_metadata_only",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"metadata-center natural stop"}]}]
        })])),
    };
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayStoplessControlScope::new(
        "/v1/responses",
        "session-stopless-center-metadata-only",
        "conversation-stopless-center-metadata-only",
        5555,
        "controlled",
    );

    let result = execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-center-metadata-only".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"Trigger stopless center without local continuation"}],
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        &stopless_control,
        scope.clone(),
    )
    .await
    .unwrap();

    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            let serialized = serde_json::to_string(&body).unwrap();
            for forbidden in [
                "call_stopless_reasoning",
                "routecodex hook run reasoningStop",
                "--input-json",
                "session-stopless-center-metadata-only",
                "conversation-stopless-center-metadata-only",
                "repeatCount",
                "schemaFeedback",
                "runtime_control",
            ] {
                assert!(
                    !serialized.contains(forbidden),
                    "client response leaked StoplessCenter state {forbidden}: {serialized}"
                );
            }
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("metadata-only stopless test must be JSON"),
    }
    assert_eq!(
        stopless_control.len().unwrap(),
        1,
        "StoplessCenter control must persist through MetadataCenter control state without local continuation storage"
    );
    let stored = stopless_control
        .load_for_scope(&scope)
        .unwrap()
        .expect("StoplessCenter state must be stored for client session scope");
    assert_eq!(
        stored.last_request_id(),
        Some("req-stopless-center-metadata-only")
    );
    assert!(
        stored.updated_at() > 0,
        "StoplessCenter state must record a transition timestamp"
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_provider_stopless_guidance(&captures[0]);
    assert_no_structured_stopless_control_fields(&captures[0], "$provider");
}

#[tokio::test]
async fn json_stopless_center_missing_client_session_scope_passes_stop_without_control_write() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_stopless_missing_session",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"missing session natural stop"}]}]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "request:req-stopless-missing-session",
        "request:req-stopless-missing-session",
        5555,
        "controlled",
    );

    let result = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-missing-session".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"No session id must not start stopless control"}],
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope,
            41_000,
        ),
    )
    .await
    .unwrap();

    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(
                body["status"], "completed",
                "missing session scope must pass natural stop through without no-op projection"
            );
            let serialized = serde_json::to_string(&body).unwrap();
            assert!(serialized.contains("missing session natural stop"));
            for forbidden in [
                "call_stopless_reasoning",
                "routecodex hook run reasoningStop",
            ] {
                assert!(
                    !serialized.contains(forbidden),
                    "missing session scope must not project stopless artifact {forbidden}: {serialized}"
                );
            }
        }
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("missing session stopless boundary test must be JSON")
        }
    }
    assert!(
        stopless_control.is_empty().unwrap(),
        "missing session scope must not write StoplessCenter control state"
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let provider_request = serde_json::to_string(&captures[0]).unwrap();
    for forbidden in ["reasoningStop", "当前轮推进准则"] {
        assert!(
            !provider_request.contains(forbidden),
            "missing session scope must not inject stopless provider guidance/tool {forbidden}: {provider_request}"
        );
    }
}

#[tokio::test]
async fn json_stopless_center_noop_cli_roundtrip_preserves_provider_tools() {
    let original_tools = json!([
        {"type":"function","name":"exec","description":"original exec","parameters":{"type":"object","properties":{},"additionalProperties":true}},
        {"type":"function","name":"wait","description":"original wait","parameters":{"type":"object","properties":{},"additionalProperties":true}}
    ]);
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = Arc::new(V3ResponsesRelayStoplessControlState::default());
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-center-runtime",
        "conversation-stopless-center-runtime",
        5555,
        "controlled",
    );
    let transport = StoplessInFlightProbeTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_stopless_center_1",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"runtime natural stop"}]}]
            }),
            json!({
                "id":"resp_stopless_center_2",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_model_reasoning_stop_terminal",
                    "name":"reasoningStop",
                    "arguments":"{\"stopreason\":0,\"evidence\":\"runtime completed\"}"
                }]
            }),
        ])),
        stopless_control: Arc::clone(&stopless_control),
        stopless_scope: V3ResponsesRelayStoplessControlScope::from(&scope),
    };

    let first = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-center-1".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"Trigger stopless center"}],
                "tools": original_tools.clone(),
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            stopless_control.as_ref(),
            scope.clone(),
            30_000,
        ),
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            let serialized = serde_json::to_string(&body).unwrap();
            for forbidden in [
                "call_stopless_reasoning",
                "routecodex hook run reasoningStop",
                "--input-json",
                "repeatCount",
                "schemaFeedback",
                "next_step",
                "<rcc_stop_schema>",
            ] {
                assert!(
                    !serialized.contains(forbidden),
                    "client response leaked old stopless state {forbidden}: {serialized}"
                );
            }
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("first stopless turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 0);
    assert_eq!(stopless_control.len().unwrap(), 1);

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    for capture in captures.iter() {
        assert_provider_stopless_guidance(capture);
        assert_original_tools_preserved(capture, original_tools.as_array().unwrap());
        assert_no_stopless_shell_artifacts(capture);
        assert_no_structured_stopless_control_fields(capture, "$provider");
    }
}

#[tokio::test]
async fn json_stopless_center_noop_cli_roundtrip_preserves_additional_tools_surface() {
    let original_tools = json!([
        {"type":"custom","name":"exec","description":"original exec","format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}},
        {"type":"function","name":"wait","description":"original wait","parameters":{"type":"object","properties":{},"additionalProperties":true}},
        {"type":"function","name":"request_user_input","description":"original ask","parameters":{"type":"object","properties":{},"additionalProperties":true}}
    ]);
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = Arc::new(V3ResponsesRelayStoplessControlState::default());
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-additional-tools-runtime",
        "conversation-stopless-additional-tools-runtime",
        5555,
        "controlled",
    );
    let transport = StoplessInFlightProbeTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"resp_stopless_additional_tools_1",
                "status":"completed",
                "finish_reason":"stop",
                "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"runtime natural stop"}]}]
            }),
            json!({
                "id":"resp_stopless_additional_tools_2",
                "status":"requires_action",
                "output":[{
                    "type":"function_call",
                    "call_id":"call_exec_after_stopless",
                    "name":"exec",
                    "arguments":"{}"
                }]
            }),
        ])),
        stopless_control: Arc::clone(&stopless_control),
        stopless_scope: V3ResponsesRelayStoplessControlScope::from(&scope),
    };

    let first = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-additional-tools-1".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[
                    {"type":"additional_tools","role":"developer","tools":original_tools.clone()},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"Trigger stopless center with additional_tools"}]}
                ],
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            stopless_control.as_ref(),
            scope.clone(),
            32_000,
        ),
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            let serialized = serde_json::to_string(&body).unwrap();
            assert!(!serialized.contains("call_stopless_reasoning"));
            assert!(!serialized.contains("routecodex hook run reasoningStop"));
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("first stopless turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 0);
    assert_eq!(stopless_control.len().unwrap(), 1);

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_additional_tools_preserved_without_shape_rebuild(
        &captures[0],
        original_tools.as_array().unwrap(),
    );
    assert_no_stopless_shell_artifacts(&captures[0]);
    assert_no_structured_stopless_control_fields(&captures[0], "$provider");
}

#[tokio::test]
async fn json_stopless_center_route_terminal_error_clears_consumed_noop_state() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_stopless_error_cleanup_1",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"cleanup first stop"}]}]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-error-cleanup",
        "conversation-stopless-error-cleanup",
        5555,
        "controlled",
    );

    let first = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-error-cleanup-1".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"Trigger cleanup stopless"}],
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope.clone(),
            70_000,
        ),
    )
    .await
    .unwrap();
    match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            let serialized = serde_json::to_string(&body).unwrap();
            assert!(!serialized.contains("call_stopless_reasoning"));
            assert!(!serialized.contains("routecodex hook run reasoningStop"));
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("first cleanup turn must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 0);
    assert_eq!(stopless_control.len().unwrap(), 1);

    let target_exhaustion_manifest = manifest_with_unsupported_provider_wire_target();

    let second = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &target_exhaustion_manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-error-cleanup-2".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"continue after cleanup stop"}],
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope,
            70_001,
        ),
    )
    .await
    .expect_err("selected target exhaustion must remain a real runtime error");
    let error_text = second.to_string();
    assert!(
        error_text.contains("target resolution failed")
            || error_text.contains("V3TargetExhaustion"),
        "unexpected terminal route error: {second}"
    );
    assert!(
        error_text.contains("unsupported provider wire protocol"),
        "negative fixture must fail at target/provider-wire selection before provider send: {second}"
    );
    assert_eq!(
        transport.captures.lock().unwrap().len(),
        1,
        "terminal target selection error must occur before a second provider send"
    );
    assert_eq!(
        stopless_control.len().unwrap(),
        1,
        "target selection failed before any stopless no-op submit was consumed, so the existing side-channel state must remain untouched"
    );
}

#[tokio::test]
async fn json_stopless_center_natural_stop_guard_passes_cleaned_original_response() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({"id":"resp_guard_1","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard first"}]}),
            json!({"id":"resp_guard_2","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard second"}]}),
            json!({"id":"resp_guard_3","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard third projected"}]}),
            json!({"id":"resp_guard_4","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard fourth projected"}]}),
            json!({"id":"resp_guard_5","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard fifth visible"}]}),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-guard",
        "conversation-stopless-guard",
        5555,
        "controlled",
    );

    for round in 1..=4 {
        let body = json!({"model":"gpt-5.5","input":[{"role":"user","content":format!("guard round {round}")}],"stream":false});
        let out = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
            &manifest(),
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: format!("req-stopless-guard-{round}"),
                payload: body,
            },
            &transport,
            &provider_health,
            V3ResponsesRelayLocalStoplessControlInput::new(
                &state,
                &stopless_control,
                scope.clone(),
                40_000 + round,
            ),
        )
        .await
        .unwrap();
        match out.client_body {
            V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
            V3ResponsesRelayClientBody::Sse(_) => panic!("guard round must be JSON"),
        }
    }
    assert_eq!(stopless_control.len().unwrap(), 1);
    let fifth = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-guard-5".into(),
            payload: json!({"model":"gpt-5.5","input":[{"role":"user","content":"guard round 5"}],"stream":false}),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope,
            40_005,
        ),
    ).await.unwrap();
    match fifth.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            let serialized = serde_json::to_string(&body).unwrap();
            assert!(serialized.contains("guard fifth visible"));
            assert!(!serialized.contains("call_stopless_reasoning"));
            assert!(!serialized.contains("routecodex hook run reasoningStop"));
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("guard terminal must be JSON"),
    }
    let captures = transport.captures.lock().unwrap();
    let fifth_request = serde_json::to_string(&captures[4]).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "reasoningStop",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !fifth_request.contains(forbidden),
            "stopless control must stay out of provider payload on guard terminal: {fifth_request}"
        );
    }
    assert_eq!(stopless_control.len().unwrap(), 1);
}

#[tokio::test]
async fn provider_request_dry_run_with_stopless_control_is_read_only() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_stopless_control_dryrun_readonly_1",
            "status":"completed",
            "finish_reason":"stop",
            "output":[{"type":"output_text","text":"dry-run readonly first stop"}]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-control-dryrun-readonly",
        "conversation-stopless-control-dryrun-readonly",
        5555,
        "controlled",
    );
    let stopless_scope = V3ResponsesRelayStoplessControlScope::from(&scope);

    let first = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-control-dryrun-readonly-1".into(),
            payload: json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"dry-run readonly"}],
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope.clone(),
            90_000,
        ),
    )
    .await
    .unwrap();
    let first_body = match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("first dry-run readonly turn must be JSON"),
    };
    assert_eq!(first_body["status"], "completed");
    let stored_before = stopless_control
        .load_for_scope(&stopless_scope)
        .unwrap()
        .expect("first stopless state");
    assert_eq!(stored_before.consecutive_stop_count(), 1);
    assert_eq!(
        stored_before.phase(),
        V3StoplessCenterPhase::CliNoopProjected
    );

    let dry_run_payload = json!({
        "model":"gpt-5.5",
        "input":[{"role":"user","content":"dry-run readonly follow-up without continuation"}],
        "stream":false
    });

    let dry_run =
        execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control(
            &manifest(),
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-stopless-control-dryrun-readonly-2".into(),
                payload: dry_run_payload.clone(),
            },
            &state,
            &stopless_control,
            scope.clone(),
            90_100,
        )
        .await;
    assert_eq!(dry_run.status, 200, "{}", dry_run.body);
    let dry_run_body_serialized = serde_json::to_string(&dry_run.body).unwrap();
    assert!(
        !dry_run_body_serialized.contains("\"id\":\"dry_run_")
            && !dry_run_body_serialized.contains("\"previous_response_id\":\"dry_run_"),
        "provider-request dry-run must not expose client-consumable continuation ids: {dry_run_body_serialized}"
    );
    assert_eq!(
        dry_run.body["dry_run"]["response_payload"]["object"],
        "routecodex.provider_request_dry_run_terminal"
    );
    assert!(
        dry_run.body["dry_run"]["response_payload"]
            .get("id")
            .is_none(),
        "dry-run terminal payload must not look like a continuable Responses payload"
    );
    let stored_after = stopless_control
        .load_for_scope(&stopless_scope)
        .unwrap()
        .expect("dry-run must not clear live stopless state");
    assert_eq!(
        stored_after, stored_before,
        "provider-request dry-run is observational and must not advance StoplessCenter state"
    );

    let second_dry_run =
        execute_v3_responses_relay_dry_run_runtime_with_local_continuation_and_stopless_control(
            &manifest(),
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-stopless-control-dryrun-readonly-3".into(),
                payload: dry_run_payload,
            },
            &state,
            &stopless_control,
            scope,
            90_200,
        )
        .await;
    assert_eq!(second_dry_run.status, 200);
    let first_provider_request = dry_run
        .body
        .get("providerRequest")
        .expect("first dry-run provider request");
    let first_provider_request_serialized = serde_json::to_string(first_provider_request).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "reasoningStop",
        "routecodex hook run reasoningStop",
    ] {
        assert!(
            !first_provider_request_serialized.contains(forbidden),
            "provider-request dry-run leaked stopless control token {forbidden}: {first_provider_request_serialized}"
        );
    }
    let second_provider_request = second_dry_run
        .body
        .get("providerRequest")
        .expect("second dry-run provider request");
    assert_eq!(
        first_provider_request, second_provider_request,
        "repeated provider-request dry-runs against the same live state must produce identical provider requests"
    );
    let stored_after_second = stopless_control
        .load_for_scope(&stopless_scope)
        .unwrap()
        .expect("second dry-run must not clear live stopless state");
    assert_eq!(
        stored_after_second, stored_before,
        "repeated provider-request dry-run must remain read-only for StoplessCenter"
    );
}

#[tokio::test]
async fn json_stopless_center_guard_passes_through_stop_without_internal_diagnostic() {
    let control_only_text = r#"{"stopreason":2,"current_goal":"guard","next_step":"continue"}"#;
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({"id":"resp_guard_diag_1","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard first"}]}),
            json!({"id":"resp_guard_diag_2","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard second"}]}),
            json!({"id":"resp_guard_diag_3","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard third"}]}),
            json!({"id":"resp_guard_diag_4","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":"guard fourth"}]}),
            json!({"id":"resp_guard_diag_5","status":"completed","finish_reason":"stop","output":[{"type":"output_text","text":control_only_text}],"output_text":control_only_text}),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-guard-pass-through",
        "conversation-stopless-guard-pass-through",
        5555,
        "controlled",
    );

    for round in 1..=4 {
        let body = json!({"model":"gpt-5.5","input":[{"role":"user","content":format!("guard pass through round {round}")}],"stream":false});
        let out = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
            &manifest(),
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: format!("req-stopless-guard-pass-through-{round}"),
                payload: body,
            },
            &transport,
            &provider_health,
            V3ResponsesRelayLocalStoplessControlInput::new(
                &state,
                &stopless_control,
                scope.clone(),
                41_000 + round,
            ),
        )
        .await
        .unwrap();
        match out.client_body {
            V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "completed"),
            V3ResponsesRelayClientBody::Sse(_) => panic!("guard pass-through round must be JSON"),
        }
    }

    let fifth = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-guard-pass-through-5".into(),
            payload: json!({"model":"gpt-5.5","input":[{"role":"user","content":"guard pass through round 5"}],"stream":false}),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope,
            41_005,
        ),
    ).await.unwrap();
    match fifth.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            assert_eq!(body["finish_reason"], "stop");
            let serialized = serde_json::to_string(&body).unwrap();
            assert_ne!(
                body["output_text"],
                json!(control_only_text),
                "guard terminal must stop intercepting but must not pass through raw stop schema control text"
            );
            assert!(
                !serialized.contains("Stopless 已达到连续自动续轮上限"),
                "guard terminal must not expose internal stopless budget state: {serialized}"
            );
            for forbidden_control in ["stopreason", "current_goal", "next_step"] {
                assert!(
                    !serialized.contains(forbidden_control),
                    "guard terminal must strip raw schema/control marker {forbidden_control}: {serialized}"
                );
            }
            for forbidden in [
                "call_stopless_reasoning",
                "routecodex hook run reasoningStop",
            ] {
                assert!(
                    !serialized.contains(forbidden),
                    "guard terminal must not project another no-op bridge artifact {forbidden}: {serialized}"
                );
            }
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("guard pass-through terminal must be JSON"),
    }
    assert_eq!(stopless_control.len().unwrap(), 1);
}

#[tokio::test]
async fn sse_runtime_runs_stopless_center_through_json_hub_pipeline_before_client_sse() {
    let transport = StoplessSseTransport {
        captures: Mutex::new(Vec::new()),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-sse-center",
        "conversation-stopless-sse-center",
        5555,
        "controlled",
    );

    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-sse-center".into(),
            payload: json!({"model":"gpt-5.5","input":[{"role":"user","content":"stream stopless"}],"stream":true}),
        },
        &transport,
        &state,
        scope,
        50_000,
    ).await.unwrap();
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut text = String::new();
            while let Some(chunk) = stream.next().await {
                text.push_str(&String::from_utf8(chunk.unwrap()).unwrap());
            }
            assert!(
                text.contains("event: response.completed"),
                "Responses client SSE must terminate stopless projection with response.completed: {text}"
            );
            assert!(
                text.contains("event: response.done"),
                "Responses client SSE must emit response.done before [DONE]: {text}"
            );
            assert!(
                !text.contains("event: response.requires_action"),
                "Responses client SSE must not use response.requires_action as terminal stream event: {text}"
            );
            assert!(
                text.contains("\"status\":\"completed\""),
                "Responses client SSE terminal response must preserve completed status without stopless bridge: {text}"
            );
            assert!(!text.contains("call_stopless_reasoning"));
            assert!(!text.contains("routecodex hook run reasoningStop"));
            let completed = text
                .find("event: response.completed")
                .expect("response completed event");
            let done = text
                .find("event: response.done")
                .expect("response done event");
            let marker = text.find("data: [DONE]").expect("DONE marker");
            assert!(
                completed < done && done < marker,
                "Responses client SSE terminal ordering must be response.completed -> response.done -> [DONE]: {text}"
            );
            assert!(!text.contains("--input-json"));
            assert!(!text.contains("repeatCount"));
            assert!(!text.contains("<rcc_stop_schema>"));
        }
        V3ResponsesRelayClientBody::Json(_) => {
            panic!("SSE stopless runtime must return SSE client body")
        }
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-reasoning-text-runtime".into(),
            payload: json!({
                "model":"gpt-5.5",
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
    assert!(captures[0].get("tools").is_none());
    assert_no_stopless_shell_artifacts(&captures[0]);
}

#[tokio::test]
async fn provider_request_dry_run_uses_live_local_continuation_state() {
    let transport = SequentialJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"resp_stopless_dry_run_preserve_tools_1",
            "status":"requires_action",
            "finish_reason":"tool_calls",
            "output":[{
                "type":"function_call",
                "call_id":"call_dry_run_exec",
                "name":"exec_command",
                "arguments":"{}"
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
        "model":"gpt-5.5",
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
        "model":"gpt-5.5",
        "previous_response_id": first_body["id"].as_str().unwrap(),
        "input":[{
            "type":"function_call_output",
            "call_id":"call_dry_run_exec",
            "output":"ok"
        }],
        "stream":false
    });

    let dry_run =
        routecodex_v3_runtime::execute_v3_responses_relay_dry_run_runtime_with_local_continuation(
            &manifest(),
            V3ResponsesRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-stopless-dry-run-2".into(),
                payload: submit_payload.clone(),
            },
            &state,
            scope.clone(),
            71_000,
        )
        .await;

    assert_eq!(dry_run.status, 200, "{}", dry_run.body);
    let dry_run_body_serialized = serde_json::to_string(&dry_run.body).unwrap();
    assert!(
        !dry_run_body_serialized.contains("\"id\":\"dry_run_")
            && !dry_run_body_serialized.contains("\"previous_response_id\":\"dry_run_"),
        "provider-request dry-run must not expose client-consumable continuation ids: {dry_run_body_serialized}"
    );
    assert_eq!(
        dry_run.body["dry_run"]["response_payload"]["object"],
        "routecodex.provider_request_dry_run_terminal"
    );
    assert!(dry_run.body["dry_run"]["response_payload"]
        .get("id")
        .is_none());
    assert!(dry_run.body["dry_run"]["response_payload"]
        .get("previous_response_id")
        .is_none());
    let provider_request = dry_run
        .body
        .get("providerRequest")
        .expect("dry-run provider request");
    let body = provider_request
        .get("body")
        .or_else(|| provider_request.get("payload"))
        .unwrap_or(provider_request);
    let input = provider_logical_input_without_stopless_system_prefix(&body["input"]);
    assert_eq!(input.len(), 3);
    assert_eq!(
        input[0]["content"][0]["text"],
        "Trigger stopless with tools"
    );
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[1]["call_id"], "call_dry_run_exec");
    assert_eq!(input[1]["name"], "exec_command");
    assert_eq!(input[2]["type"], "function_call_output");
    assert_eq!(input[2]["call_id"], "call_dry_run_exec");
    assert_eq!(input[2]["output"], "ok");
    assert_additional_tools_preserved_without_shape_rebuild(
        body,
        original_tools.as_array().unwrap(),
    );
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
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
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
        .unwrap_or(second_provider_request);
    assert_eq!(
        second_body["input"], body["input"],
        "provider-request dry-run must be observational only and must not accumulate repeated stopless prompts"
    );
    assert_additional_tools_preserved_without_shape_rebuild(
        second_body,
        original_tools.as_array().unwrap(),
    );
    assert_no_stopless_shell_artifacts(second_body);
    assert_eq!(
        state.len().unwrap(),
        1,
        "repeated provider-request dry-run must leave local continuation state unchanged"
    );
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-apply-patch-sse-1".into(),
            payload: json!({
                "model":"gpt-5.5",
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
                text.contains("event: response.output_item.added"),
                "Responses Relay client SSE must announce the finalized apply_patch tool item before output_item.done: {text}"
            );
            assert!(
                text.contains("event: response.output_item.done"),
                "Responses Relay client SSE must encode the Hub-finalized apply_patch tool item: {text}"
            );
            assert!(
                text.contains("event: response.completed"),
                "Responses Relay client SSE must terminate with response.completed while preserving Hub-finalized requires_action status: {text}"
            );
            assert!(
                text.contains("event: response.done"),
                "Responses Relay client SSE must emit response.done before the [DONE] transport marker: {text}"
            );
            assert!(
                !text.contains("event: response.requires_action"),
                "Responses Relay client SSE must not use response.requires_action as the terminal stream event: {text}"
            );
            assert!(text.contains("\"status\":\"requires_action\""));
            assert!(text.contains("\"type\":\"custom_tool_call\""));
            assert!(text.contains("\"name\":\"apply_patch\""));
            assert!(text.contains("\"call_id\":\"call_apply_patch_sse\""));
            assert!(text.contains("*** Begin Patch"));
            assert!(
                !text.contains("event: response.function_call_arguments.done"),
                "custom apply_patch input must not be projected as a standard function_call arguments event: {text}"
            );
            assert!(text.contains("[DONE]"));
            let output_item_added = text
                .find("event: response.output_item.added")
                .expect("output item added event");
            let output_item_done = text
                .find("event: response.output_item.done")
                .expect("output item done event");
            let completed = text
                .find("event: response.completed")
                .expect("response completed event");
            let done = text
                .find("event: response.done")
                .expect("response done event");
            let marker = text.find("data: [DONE]").expect("DONE marker");
            assert!(
                output_item_added < output_item_done
                    && output_item_done < completed
                    && completed < done
                    && done < marker,
                "Responses Relay custom tool SSE order must be output_item.added -> output_item.done -> response.completed -> response.done -> [DONE]: {text}"
            );
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-local-1".into(),
            payload: json!({
                "model":"gpt-5.5",
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-local-2".into(),
            payload: json!({
                "model":"gpt-5.5",
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
        strip_generated_responses_item_ids(provider_logical_input_without_stopless_system_prefix(
            &captures[1]["input"]
        )),
        vec![
            json!({
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"Lookup alpha"}]
            }),
            json!({
                "type":"function_call",
                "call_id":"call_local_1",
                "name":"lookup",
                "arguments":"{\"q\":\"alpha\"}"
            }),
            json!({
                "type":"function_call_output",
                "call_id":"call_local_1",
                "output":"alpha"
            })
        ]
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
        "model":"gpt-5.5",
        "input":[original_additional_tools_item.clone(), original_user_item.clone()],
        "stream":false
    });

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-additional-tools-normal-2".into(),
            payload: json!({
                "model":"gpt-5.5",
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
        captures[0].get("tools").and_then(Value::as_array).is_some(),
        "round-1 provider request must project Chat tools to the target Responses top-level tool surface: {}",
        captures[0]
    );
    assert!(
        captures[1].get("tools").and_then(Value::as_array).is_some(),
        "round-2 provider request must project Chat tools to the target Responses top-level tool surface: {}",
        captures[1]
    );
    let round2_input = provider_logical_input_without_stopless_system_prefix(&captures[1]["input"]);
    assert_eq!(
        round2_input.len(),
        3,
        "round-2 provider input must be original user + restored tool call + current tool output; tools live in $.tools after ReqInbound Chat normalization: {round2_input:?}"
    );
    assert_eq!(round2_input[0]["role"], original_user_item["role"]);
    assert_eq!(
        round2_input[0]["content"][0]["text"],
        original_user_item["content"]
    );
    assert_eq!(
        strip_generated_responses_item_ids(vec![round2_input[1].clone()])[0],
        provider_function_call
    );
    assert_eq!(
        strip_generated_responses_item_ids(vec![round2_input[2].clone()])[0],
        provider_function_output
    );
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-apply-patch-1".into(),
            payload: json!({
                "model":"gpt-5.5",
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-apply-patch-2".into(),
            payload: json!({
                "model":"gpt-5.5",
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
    let logical_input =
        provider_logical_input_without_stopless_system_prefix(&captures[1]["input"]);
    assert_eq!(logical_input[0]["role"], "user");
    assert_eq!(
        logical_input[0]["content"],
        json!([{"type":"input_text","text":"Patch a file"}])
    );
    assert_eq!(logical_input[1]["type"], "custom_tool_call");
    assert_eq!(logical_input[1]["name"], "apply_patch");
    assert_eq!(logical_input[1]["input"], patch);
    assert_eq!(logical_input[2]["type"], "custom_tool_call_output");
    let feedback = logical_input[2]["output"].as_str().unwrap();
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-wrong-1".into(),
            payload: json!({
                "model":"gpt-5.5",
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-wrong-2".into(),
            payload: json!({
                "model":"gpt-5.5",
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-full-history".into(),
            payload: json!({
                "model":"gpt-5.5",
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
    let logical_input =
        provider_logical_input_without_stopless_system_prefix(&captures[0]["input"]);
    assert_eq!(logical_input[1]["call_id"], "call_full_history");
    assert_eq!(logical_input[2]["call_id"], "call_full_history");
}

#[tokio::test]
async fn responses_relay_selected_openai_chat_provider_uses_chat_wire_tools_and_schema() {
    let original_tools = json!([
        {
            "type":"custom",
            "name":"exec",
            "description":"Execute freeform script",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}
        },
        {
            "type":"function",
            "name":"wait",
            "description":"Wait",
            "parameters":{"type":"object","properties":{"seconds":{"type":"number"}}},
            "strict":false
        },
        {
            "type":"function",
            "name":"request_user_input",
            "description":"Ask",
            "parameters":{"type":"object","properties":{"prompt":{"type":"string"}}},
            "strict":true
        }
    ]);
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-stopless-wire",
            "object":"chat.completion",
            "choices":[{
                "index":0,
                "message":{
                    "role":"assistant",
                    "content":null,
                    "tool_calls":[{
                        "id":"call_chat_reasoning_stop_terminal",
                        "type":"function",
                        "function":{
                            "name":"reasoningStop",
                            "arguments":"{\"stopreason\":0,\"evidence\":\"chat wire ok\"}"
                        }
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-openai-chat-wire",
        "conversation-openai-chat-wire",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-wire".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "instructions":"client instruction",
                "input":[
                    {"type":"additional_tools","role":"system","tools":original_tools.clone()},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"Trigger chat provider wire"}]}
                ]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await;

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "provider send cutpoint must be captured");
    let projection = &captures[0];
    assert_eq!(
        projection["url"], "http://chatwire.invalid/v1/chat/completions",
        "responses relay selected openai_chat provider must send OpenAI Chat wire URL: {projection}"
    );
    let body = provider_projection_body(projection);
    assert!(
        body.get("input").is_none(),
        "OpenAI Chat provider wire must not leak Responses input shape: {body}"
    );
    assert!(
        body.get("instructions").is_none(),
        "schema guidance for OpenAI Chat provider must be carried by provider-visible system/developer message, not a stray Responses instructions field: {body}"
    );
    assert_provider_chat_stopless_guidance(body);
    assert_openai_chat_wire_tools_semantically_preserve_responses_tools(
        body,
        original_tools.as_array().unwrap(),
    );
    assert_no_structured_stopless_control_fields(body, "provider.chat");
    let messages = body["messages"]
        .as_array()
        .expect("OpenAI Chat provider messages");
    assert!(
        messages.iter().any(|message| {
            message.get("role").and_then(Value::as_str) == Some("user")
                && serde_json::to_string(message)
                    .unwrap()
                    .contains("Trigger chat provider wire")
        }),
        "OpenAI Chat provider messages must preserve original user input: {messages:?}"
    );
    assert!(
        result.is_ok(),
        "OpenAI Chat provider response must re-enter Responses relay response Chat Process cleanly: {result:?}"
    );
    assert!(state.is_empty().unwrap());
}

#[tokio::test]
async fn responses_openai_chat_natural_stopless_submit_restores_additional_tools_for_provider_wire()
{
    let original_tools = json!([
        {
            "type":"custom",
            "name":"exec",
            "description":"Execute freeform script",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}
        },
        {
            "type":"function",
            "name":"wait",
            "description":"Wait",
            "parameters":{"type":"object","properties":{"seconds":{"type":"number"}}},
            "strict":false
        },
        {
            "type":"function",
            "name":"request_user_input",
            "description":"Ask",
            "parameters":{"type":"object","properties":{"prompt":{"type":"string"}}},
            "strict":true
        }
    ]);
    let transport = ProviderProjectionFirstSseThenJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"chatcmpl-stopless-natural-wire-1",
                "object":"chat.completion",
                "choices":[{
                    "index":0,
                    "message":{"role":"assistant","content":"natural stop without tool"},
                    "finish_reason":"stop"
                }]
            }),
            json!({
                "id":"chatcmpl-stopless-natural-wire-2",
                "object":"chat.completion",
                "choices":[{
                    "index":0,
                    "message":{
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"call_exec_after_natural_stopless_submit",
                            "type":"function",
                            "function":{"name":"exec","arguments":"{\"input\":\"pwd\"}"}
                        }]
                    },
                    "finish_reason":"tool_calls"
                }]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest_openai_chat_wire());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-openai-chat-natural-stopless-submit-tools",
        "conversation-openai-chat-natural-stopless-submit-tools",
        5555,
        "chatwire",
    );

    let first = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-natural-stopless-submit-tools-1".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "instructions":"client instruction",
                "input":[
                    {"type":"additional_tools","role":"system","tools":original_tools.clone()},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"Trigger chat provider natural stopless submit"}]}
                ]
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope.clone(),
            12_300,
        ),
    )
    .await
    .expect("first natural stopless OpenAI Chat provider turn must project no-op continuation");
    let first_body = match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("OpenAI Chat provider test must be JSON"),
    };
    assert_eq!(first_body["status"], "completed");
    let first_serialized = serde_json::to_string(&first_body).unwrap();
    assert!(!first_serialized.contains("call_stopless_reasoning"));
    assert!(!first_serialized.contains("routecodex hook run reasoningStop"));
    assert_eq!(stopless_control.len().unwrap(), 1);

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "provider send must be captured once");
    let body = provider_projection_body(&captures[0]);
    assert_openai_chat_wire_tools_semantically_preserve_responses_tools(
        body,
        original_tools.as_array().unwrap(),
    );
    assert_provider_chat_stopless_guidance(body);
    assert_no_structured_stopless_control_fields(body, "provider.chat.natural-stopless.submit");
}

#[tokio::test]
async fn responses_openai_chat_stopless_submit_restores_additional_tools_for_provider_wire() {
    let original_tools = json!([
        {
            "type":"custom",
            "name":"exec",
            "description":"Execute freeform script",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}
        },
        {
            "type":"function",
            "name":"wait",
            "description":"Wait",
            "parameters":{"type":"object","properties":{"seconds":{"type":"number"}}},
            "strict":false
        },
        {
            "type":"function",
            "name":"request_user_input",
            "description":"Ask",
            "parameters":{"type":"object","properties":{"prompt":{"type":"string"}}},
            "strict":true
        }
    ]);
    let transport = ProviderProjectionFirstSseThenJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([
            json!({
                "id":"chatcmpl-stopless-submit-wire-1",
                "object":"chat.completion",
                "choices":[{
                    "index":0,
                    "message":{
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"call_stopless_reasoning",
                            "type":"function",
                            "function":{
                                "name":"exec_command",
                                "arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"
                            }
                        }]
                    },
                    "finish_reason":"tool_calls"
                }]
            }),
            json!({
                "id":"chatcmpl-stopless-submit-wire-2",
                "object":"chat.completion",
                "choices":[{
                    "index":0,
                    "message":{
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"call_wait_after_stopless_submit",
                            "type":"function",
                            "function":{"name":"wait","arguments":"{\"seconds\":1}"}
                        }]
                    },
                    "finish_reason":"tool_calls"
                }]
            }),
        ])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-openai-chat-stopless-submit-tools",
        "conversation-openai-chat-stopless-submit-tools",
        5555,
        "chatwire",
    );

    let first = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-stopless-submit-tools-1".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "instructions":"client instruction",
                "input":[
                    {"type":"additional_tools","role":"system","tools":original_tools.clone()},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"Trigger chat provider stopless submit"}]}
                ]
            }),
        },
        &transport,
        &state,
        scope.clone(),
        12_100,
    )
    .await
    .expect("first stopless OpenAI Chat provider turn must project no-op continuation");
    let first_body = match first.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("OpenAI Chat provider test must be JSON"),
    };
    assert_eq!(first_body["status"], "requires_action");

    let second = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-stopless-submit-tools-2".into(),
            payload: json!({
                "model":"gpt-5.5",
                "previous_response_id": first_body["id"].as_str().unwrap(),
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_stopless_reasoning",
                    "output":""
                }],
                "stream":false
            }),
        },
        &transport,
        &state,
        scope,
        12_200,
    )
    .await
    .expect("stopless no-op submit must restore original tool surface before provider send");
    match second.client_body {
        V3ResponsesRelayClientBody::Json(body) => assert_eq!(body["status"], "requires_action"),
        V3ResponsesRelayClientBody::Sse(_) => panic!("OpenAI Chat provider test must be JSON"),
    }

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2, "both provider sends must be captured");
    for (index, projection) in captures.iter().enumerate() {
        assert_eq!(
            projection["url"], "http://chatwire.invalid/v1/chat/completions",
            "round {index} must use OpenAI Chat provider wire URL: {projection}"
        );
        let body = provider_projection_body(projection);
        assert_openai_chat_wire_tools_semantically_preserve_responses_tools(
            body,
            original_tools.as_array().unwrap(),
        );
        assert_provider_chat_stopless_guidance(body);
        assert_no_structured_stopless_control_fields(body, "provider.chat.stopless.submit");
    }
}

#[tokio::test]
async fn responses_relay_selected_openai_chat_provider_restores_custom_tool_call_for_client() {
    let original_tools = json!([
        {
            "type":"custom",
            "name":"exec",
            "description":"Execute freeform script",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}
        },
        {
            "type":"function",
            "name":"wait",
            "description":"Wait",
            "parameters":{"type":"object","properties":{"seconds":{"type":"number"}}}
        },
        {
            "type":"function",
            "name":"request_user_input",
            "description":"Ask",
            "parameters":{"type":"object","properties":{"prompt":{"type":"string"}}}
        }
    ]);
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-custom-tool",
            "object":"chat.completion",
            "choices":[{
                "index":0,
                "message":{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_exec_1",
                        "type":"custom",
                        "custom":{
                            "name":"exec",
                            "input":"text('hello from custom exec')"
                        }
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-openai-chat-custom",
        "conversation-openai-chat-custom",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-custom".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "instructions":"client instruction",
                "input":[
                    {"type":"additional_tools","role":"system","tools":original_tools.clone()},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"Trigger custom exec"}]}
                ]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("OpenAI Chat provider custom tool response must project back to Responses");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "provider send cutpoint must be captured");
    let body = provider_projection_body(&captures[0]);
    let tools = body["tools"].as_array().expect("provider custom tools");
    assert_eq!(
        tools.len(),
        original_tools.as_array().unwrap().len(),
        "{tools:?}"
    );
    assert_eq!(tools[0]["type"], "custom");
    assert_eq!(tools[0]["custom"]["name"], "exec");
    assert_eq!(tools[0]["custom"]["format"]["type"], "grammar");
    assert!(tools[0].get("function").is_none(), "{tools:?}");
    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action", "{body}");
            assert_eq!(body["output"][0]["type"], "custom_tool_call", "{body}");
            assert_eq!(body["output"][0]["call_id"], "call_exec_1", "{body}");
            assert_eq!(body["output"][0]["name"], "exec", "{body}");
            assert_eq!(
                body["output"][0]["input"], "text('hello from custom exec')",
                "{body}"
            );
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("custom tool response must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);
}

#[tokio::test]
async fn responses_relay_selected_openai_chat_provider_restores_custom_tool_call_with_unescaped_raw_input(
) {
    let original_tools = json!([
        {
            "type":"custom",
            "name":"exec",
            "description":"Execute freeform script",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}
        }
    ]);
    let raw_script = "python - <<'PY'\nprint(\"hello from custom exec\")\nPY";
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-custom-tool-unescaped",
            "object":"chat.completion",
            "choices":[{
                "index":0,
                "message":{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_exec_unescaped",
                        "type":"custom",
                        "custom":{
                            "name":"exec",
                            "input": raw_script
                        }
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-openai-chat-custom-unescaped",
        "conversation-openai-chat-custom-unescaped",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-custom-unescaped".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "instructions":"client instruction",
                "input":[
                    {"type":"additional_tools","role":"system","tools":original_tools.clone()},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"Trigger custom exec with quoted script"}]}
                ]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("OpenAI Chat provider custom tool response with unescaped raw input must project back to Responses");

    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action", "{body}");
            assert_eq!(body["output"][0]["type"], "custom_tool_call", "{body}");
            assert_eq!(
                body["output"][0]["call_id"], "call_exec_unescaped",
                "{body}"
            );
            assert_eq!(body["output"][0]["name"], "exec", "{body}");
            assert_eq!(body["output"][0]["input"], raw_script, "{body}");
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("custom tool response must be JSON"),
    }
    assert_eq!(state.len().unwrap(), 1);
}

#[tokio::test]
async fn responses_openai_chat_field_parity_request_matrix() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-field-parity-request",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "message":{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_lookup_matrix",
                        "type":"function",
                        "function":{"name":"lookup","arguments":"{\"q\":\"matrix\"}"}
                    }]
                },
                "finish_reason":"tool_calls"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-responses-openai-chat-field-request",
        "conversation-responses-openai-chat-field-request",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-openai-chat-field-request".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "instructions":"field parity system",
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"run request matrix"}]}],
                "tools":[{
                    "type":"function",
                    "name":"lookup",
                    "description":"Lookup docs",
                    "parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]},
                    "strict":true
                }],
                "tool_choice":{"type":"function","name":"lookup"},
                "parallel_tool_calls":false,
                "user":"user-field-matrix",
                "temperature":0.3,
                "top_p":0.8,
                "logit_bias":{"42":1},
                "seed":123,
                "response_format":{"type":"json_object"},
                "reasoning":{"effort":"medium"},
                "max_output_tokens":321,
                "metadata":{"client":"metadata-kept"},
                "stop":["<END>"]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("Responses -> OpenAI Chat request field parity must execute");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(
        captures.len(),
        1,
        "provider send cutpoint must be captured; observability={:?}",
        result.observability
    );
    let body = provider_projection_body(&captures[0]);
    assert_eq!(body["model"], "chat-wire-model");
    assert_eq!(body["messages"][0]["role"], "system");
    assert!(
        body["messages"][0]["content"]
            .as_str()
            .is_some_and(|content| content.starts_with("field parity system")),
        "client instructions must remain the leading provider system text: {body}"
    );
    assert_eq!(body["messages"][1]["content"], "run request matrix");
    assert_eq!(
        body["tools"][0]["function"]["parameters"],
        json!({"type":"object","properties":{"q":{"type":"string"}},"required":["q"]})
    );
    assert_eq!(body["tools"][0]["function"]["strict"], true);
    assert_eq!(
        body["tool_choice"],
        json!({"type":"function","name":"lookup"})
    );
    assert_eq!(body["parallel_tool_calls"], false);
    assert_eq!(body["user"], "user-field-matrix");
    assert_eq!(body["temperature"], 0.3);
    assert_eq!(body["top_p"], 0.8);
    assert_eq!(body["logit_bias"], json!({"42":1}));
    assert_eq!(body["seed"], 123);
    assert_eq!(body["response_format"], json!({"type":"json_object"}));
    assert_eq!(body["reasoning_effort"], "medium");
    assert!(
        body.get("reasoning_summary_policy").is_none(),
        "OpenAI Chat provider wire must not receive Responses reasoning summary policy in the positive request matrix: {body}"
    );
    assert!(
        body.get("reasoning").is_none(),
        "OpenAI Chat provider wire must map only Responses reasoning.effort to reasoning_effort and keep summary/context separate: {body}"
    );
    assert_eq!(body["max_completion_tokens"], 321);
    assert!(
        body.get("max_output_tokens").is_none(),
        "OpenAI Chat provider wire must map Responses max_output_tokens to max_completion_tokens: {body}"
    );
    assert_eq!(body["metadata"], json!({"client":"metadata-kept"}));
    assert_eq!(body["stop"], json!(["<END>"]));
    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "requires_action", "{body}");
            assert_eq!(body["output"][0]["call_id"], "call_lookup_matrix");
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("field parity request matrix must be JSON"),
    }
}

#[tokio::test]
async fn responses_openai_chat_field_parity_rejects_malformed_client_metadata_before_provider_capture(
) {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::new()),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-responses-openai-chat-client-metadata-reject",
        "conversation-responses-openai-chat-client-metadata-reject",
        5555,
        "chatwire",
    );

    let error = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-openai-chat-client-metadata-reject".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"reject client metadata"}]}],
                "client_metadata":"client-metadata-must-be-an-object"
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect_err("malformed client_metadata must fail before provider send");

    let error_text = error.to_string();
    assert!(
        error_text.contains("metadata/client_metadata must be an object"),
        "{error_text}"
    );
    assert_eq!(
        transport.captures.lock().unwrap().len(),
        0,
        "OpenAI Chat provider wire must reject unsupported client_metadata before provider capture"
    );
}

#[tokio::test]
async fn responses_openai_chat_field_parity_paired_malformed_arguments_preserve_exact_string_without_reselect(
) {
    let call_id = "call_e7896581c85649b58531dfc2";
    let malformed_arguments = "{\"cmd\":\"find v2\"}{\"cmd\":\"cat bootstrap.mjs\"}";
    let parse_failure_output =
        "failed to parse function arguments: trailing characters at line 1 column 18";
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-malformed-projected-paired",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "message":{"role":"assistant","content":"projected paired malformed arguments"},
                "finish_reason":"stop"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-malformed-feedback",
        "conversation-malformed-feedback",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire_with_responses_reselect(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-malformed-feedback".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[
                    {
                        "type": "function_call",
                        "call_id": call_id,
                        "name": "exec_command",
                        "arguments": malformed_arguments
                    },
                    {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": parse_failure_output
                    }
                ]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("paired malformed OpenAI Chat arguments must preserve their exact string without provider reselect");

    assert_eq!(result.status, 200);
    assert_eq!(result.error_chain, None);
    assert!(
        !result.node_trace.contains(&"V3TargetLocalReselected"),
        "paired malformed OpenAI Chat arguments must not trigger Error05 reselect: {:?}",
        result.node_trace
    );
    let observability = result.observability.as_ref().expect("observability");
    assert!(
        observability.provider_failure_events.is_empty(),
        "projectable malformed arguments must not be wrapped as provider failure: {observability:?}"
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(
        captures.len(),
        1,
        "projectable malformed arguments must send exactly once to the selected OpenAI Chat target"
    );
    assert_eq!(
        captures[0]["url"], "http://chatwire.invalid/v1/chat/completions",
        "the selected OpenAI Chat target must receive the provider request without reselect"
    );
    let provider_body = provider_projection_body(&captures[0]);
    let tool_call_message = provider_body["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|message| message.get("tool_calls").is_some())
        .expect("assistant tool_call message");
    let wire_arguments = tool_call_message["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .expect("wire arguments string");
    assert_eq!(
        wire_arguments, malformed_arguments,
        "OpenAI Chat function.arguments must preserve the exact original string bytes"
    );
    let tool_result_message = provider_body["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("paired tool result message");
    assert_eq!(
        tool_result_message["tool_call_id"], call_id,
        "parse-failure tool result must remain paired"
    );
    assert_eq!(tool_result_message["content"], parse_failure_output);
}

#[tokio::test]
async fn responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect(
) {
    let call_id = "call_unpaired_malformed";
    let malformed_arguments = "{\"cmd\":\"one\"}{\"cmd\":\"two\"}";
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-malformed-projected-unpaired",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "message":{"role":"assistant","content":"projected unpaired malformed arguments"},
                "finish_reason":"stop"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-malformed-unpaired",
        "conversation-malformed-unpaired",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire_with_responses_reselect(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-malformed-unpaired".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[{
                    "type": "function_call",
                    "call_id": call_id,
                    "name": "exec_command",
                    "arguments": malformed_arguments
                }]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("unpaired malformed OpenAI Chat arguments must preserve their exact string without provider reselect");

    assert_eq!(result.status, 200);
    assert_eq!(result.error_chain, None);
    assert!(
        !result.node_trace.contains(&"V3TargetLocalReselected"),
        "unpaired malformed OpenAI Chat arguments must not trigger Error05 reselect: {:?}",
        result.node_trace
    );
    let observability = result.observability.as_ref().expect("observability");
    assert!(
        observability.provider_failure_events.is_empty(),
        "projectable malformed arguments must not be wrapped as provider failure: {observability:?}"
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(
        captures.len(),
        1,
        "projectable malformed arguments must send exactly once to the selected OpenAI Chat target"
    );
    assert_eq!(
        captures[0]["url"], "http://chatwire.invalid/v1/chat/completions",
        "the selected OpenAI Chat target must receive the provider request without reselect"
    );
    let provider_body = provider_projection_body(&captures[0]);
    let tool_call_message = provider_body["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|message| message.get("tool_calls").is_some())
        .expect("assistant tool_call message");
    let wire_arguments = tool_call_message["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .expect("wire arguments string");
    assert_eq!(
        wire_arguments, malformed_arguments,
        "OpenAI Chat function.arguments must preserve the exact original string bytes"
    );
}

#[tokio::test]
async fn responses_openai_chat_field_parity_web_search_call_history_projects_tool_pair() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-web-search-history",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{
                "index":0,
                "message":{"role":"assistant","content":"continued"},
                "finish_reason":"stop"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-responses-openai-chat-web-search-history",
        "conversation-responses-openai-chat-web-search-history",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-openai-chat-web-search-history".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[
                    {
                        "type":"web_search_call",
                        "status":"failed",
                        "action":{
                            "type":"search",
                            "query":"微信小程序 发布流程",
                            "queries":["微信小程序 发布流程"]
                        }
                    },
                    {
                        "type":"message",
                        "role":"user",
                        "content":[{"type":"input_text","text":"继续"}]
                    }
                ]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("Responses web_search_call history must reach OpenAI Chat provider wire");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "provider send cutpoint must be captured");
    let body = provider_projection_body(&captures[0]);
    assert!(
        body.get("input").is_none(),
        "OpenAI Chat provider wire must not receive raw Responses input: {body}"
    );
    let messages = body["messages"]
        .as_array()
        .expect("OpenAI Chat provider messages");
    assert!(
        messages.len() >= 3,
        "provider body must contain web_search history pair and final user message: {body}"
    );
    let pair_start = messages
        .iter()
        .position(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|call| {
                        call.pointer("/function/name").and_then(Value::as_str) == Some("web_search")
                    })
        })
        .expect("provider messages must include assistant web_search tool_call");
    assert!(
        pair_start + 1 < messages.len(),
        "assistant web_search tool_call must be followed by tool result: {body}"
    );
    assert_eq!(messages[pair_start]["role"], "assistant");
    assert_eq!(
        messages[pair_start]["tool_calls"][0]["id"],
        "call_routecodex_web_search_0"
    );
    assert_eq!(
        messages[pair_start]["tool_calls"][0]["function"]["name"],
        "web_search"
    );
    let arguments: Value = serde_json::from_str(
        messages[pair_start]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .expect("web_search arguments string"),
    )
    .expect("web_search arguments JSON");
    assert_eq!(
        arguments,
        json!({
            "type":"search",
            "query":"微信小程序 发布流程",
            "queries":["微信小程序 发布流程"]
        })
    );
    assert_eq!(messages[pair_start + 1]["role"], "tool");
    assert_eq!(
        messages[pair_start + 1]["tool_call_id"],
        messages[pair_start]["tool_calls"][0]["id"],
        "web_search tool result must immediately pair with the assistant tool_call"
    );
    let result_event: Value = serde_json::from_str(
        messages[pair_start + 1]["content"]
            .as_str()
            .expect("tool result content string"),
    )
    .expect("tool result content JSON");
    assert_eq!(result_event["type"], "web_search_call");
    assert_eq!(result_event["status"], "failed");
    assert_eq!(result_event["action"], arguments);
    assert_eq!(
        messages.last().cloned().unwrap_or(Value::Null),
        json!({"role":"user","content":"继续"})
    );
    assert!(
        messages
            .iter()
            .all(|message| message.get("type").and_then(Value::as_str) != Some("web_search_call")),
        "OpenAI Chat messages must not embed a native Responses web_search_call item: {body}"
    );

    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            let output_text = body
                .get("output")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find_map(|item| {
                    if item.get("type").and_then(Value::as_str) != Some("message") {
                        return None;
                    }
                    item.get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .find_map(|part| {
                            if part.get("type").and_then(Value::as_str) == Some("output_text") {
                                part.get("text").and_then(Value::as_str).map(str::to_string)
                            } else {
                                None
                            }
                        })
                })
                .or_else(|| {
                    body.get("output_text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            assert_eq!(
                output_text, "continued",
                "provider Chat response text must still project to client Responses text: {body}"
            );
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("web_search history parity must be JSON"),
    }
}

#[tokio::test]
async fn responses_openai_chat_field_parity_response_matrix() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-field-parity-response",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "created":1234567890,
            "choices":[{
                "index":0,
                "message":{
                    "role":"assistant",
                    "content":"visible answer",
                    "reasoning_content":"safe reason summary",
                    "tool_calls":[{
                        "id":"call_lookup_response",
                        "type":"function",
                        "function":{"name":"lookup","arguments":"{\"q\":\"response\"}"}
                    }]
                },
                "finish_reason":"tool_calls"
            }],
            "usage":{
                "prompt_tokens":11,
                "prompt_tokens_details":{"cached_tokens":5},
                "completion_tokens":7,
                "completion_tokens_details":{"reasoning_tokens":2},
                "total_tokens":18
            }
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-responses-openai-chat-field-response",
        "conversation-responses-openai-chat-field-response",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-responses-openai-chat-field-response".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"run response matrix"}]}],
                "tools":[{
                    "type":"function",
                    "name":"lookup",
                    "description":"Lookup docs",
                    "parameters":{"type":"object","properties":{"q":{"type":"string"}}}
                }]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("OpenAI Chat provider response must project to Responses");

    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["id"], "chatcmpl-field-parity-response");
            assert_eq!(body["model"], "chat-wire-model");
            assert_eq!(body["created_at"], 1234567890);
            assert_eq!(body["status"], "requires_action", "{body}");
            assert_eq!(body["output"][0]["type"], "reasoning");
            assert_eq!(
                body["output"][0]["summary"][0]["text"],
                "safe reason summary"
            );
            assert_eq!(body["output"][1]["type"], "output_text");
            assert_eq!(body["output"][1]["text"], "visible answer");
            assert_eq!(body["output"][2]["type"], "function_call");
            assert_eq!(body["output"][2]["call_id"], "call_lookup_response");
            assert_eq!(body["finish_reason"], "tool_calls");
            assert_eq!(body["usage"]["input_tokens"], 11);
            assert_eq!(body["usage"]["output_tokens"], 7);
            assert_eq!(body["usage"]["total_tokens"], 18);
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("field parity response matrix must be JSON"),
    }
}

#[tokio::test]
async fn responses_relay_openai_chat_provider_wire_strips_replayed_stopless_noop_cli_pair() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        responses: Mutex::new(VecDeque::from([json!({
            "id":"chatcmpl-stopless-noop-stripped",
            "object":"chat.completion",
            "choices":[{
                "index":0,
                "message":{"role":"assistant","content":"runtime completed"},
                "finish_reason":"stop"
            }]
        })])),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest_openai_chat_wire());
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-stopless-noop-provider-wire",
        "conversation-stopless-noop-provider-wire",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_transport_health_local_continuation_and_stopless_control(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-stopless-noop-provider-wire".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":false,
                "tool_choice":"auto",
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"完成当前目标"}]},
                    {"type":"message","role":"assistant","content":[{"type":"output_text","text":"上一轮自然 stop 的可见正文"}]},
                    {"type":"function_call","call_id":"call_stopless_reasoning","name":"exec_command","arguments":"{\"cmd\":\"routecodex hook run reasoningStop\"}"},
                    {"type":"function_call_output","call_id":"call_stopless_reasoning","output":"Chunk ID: 46b4b1\nWall time: 0.1266 seconds\nProcess exited with code 1\nOriginal token count: 15\nOutput:\nerror: required option '--input-json <json>' not specified\n"}
                ]
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayLocalStoplessControlInput::new(
            &state,
            &stopless_control,
            scope,
            12_500,
        ),
    )
    .await
    .expect("replayed stopless no-op CLI pair must not block provider send");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "provider send cutpoint must be captured");
    let body = provider_projection_body(&captures[0]);
    assert_eq!(body["tool_choice"], json!("auto"));
    let serialized = serde_json::to_string(body).unwrap();
    for forbidden in [
        "call_stopless_reasoning",
        "routecodex hook run reasoningStop",
        "Chunk ID",
        "required option '--input-json",
        "__routecodex_stopless_center",
        "stoplessCenter",
        "runtime_control",
        "metadata_center",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "OpenAI Chat provider wire leaked replayed stopless no-op CLI artifact {forbidden}: {serialized}"
        );
    }
    match result.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert_eq!(body["status"], "completed");
            let serialized = serde_json::to_string(&body).unwrap();
            assert!(!serialized.contains("call_stopless_reasoning"));
            assert!(!serialized.contains("routecodex hook run reasoningStop"));
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("test response must be JSON"),
    }
}

#[tokio::test]
async fn responses_relay_selected_openai_chat_provider_sse_uses_chat_wire_and_returns_responses_sse(
) {
    let original_tools = json!([
        {
            "type":"custom",
            "name":"exec",
            "description":"Execute freeform script",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE\nSOURCE: /[\\s\\S]+/"}
        },
        {
            "type":"function",
            "name":"wait",
            "description":"Wait",
            "parameters":{"type":"object","properties":{"seconds":{"type":"number"}}},
            "strict":false
        },
        {
            "type":"function",
            "name":"request_user_input",
            "description":"Ask",
            "parameters":{"type":"object","properties":{"prompt":{"type":"string"}}},
            "strict":true
        }
    ]);
    let transport = ProviderProjectionOpenAiChatSseTransport {
        captures: Mutex::new(Vec::new()),
    };
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-openai-chat-wire-sse",
        "conversation-openai-chat-wire-sse",
        5555,
        "chatwire",
    );

    let result = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest_openai_chat_wire(),
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-openai-chat-wire-sse".into(),
            payload: json!({
                "model":"gpt-5.5",
                "stream":true,
                "instructions":"client instruction",
                "input":[
                    {"type":"additional_tools","role":"system","tools":original_tools.clone()},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"Trigger chat provider wire SSE"}]}
                ]
            }),
        },
        &transport,
        &state,
        scope,
        12_000,
    )
    .await
    .expect("OpenAI Chat provider SSE must re-enter Responses relay Chat Process");

    let projection = {
        let captures = transport.captures.lock().unwrap();
        assert_eq!(
            captures.len(),
            1,
            "provider SSE send cutpoint must be captured"
        );
        captures[0].clone()
    };
    assert_eq!(
        projection["url"], "http://chatwire.invalid/v1/chat/completions",
        "streaming responses relay selected openai_chat provider must send OpenAI Chat wire URL: {projection}"
    );
    let body = provider_projection_body(&projection);
    assert_eq!(
        body["stream"],
        json!(true),
        "OpenAI Chat provider wire must preserve stream intent"
    );
    assert!(
        body.get("input").is_none(),
        "OpenAI Chat provider SSE wire must not leak Responses input shape: {body}"
    );
    assert!(
        body.get("instructions").is_none(),
        "OpenAI Chat provider SSE guidance must be carried by provider-visible messages: {body}"
    );
    assert_provider_chat_stopless_guidance(body);
    assert_openai_chat_wire_tools_semantically_preserve_responses_tools(
        body,
        original_tools.as_array().unwrap(),
    );
    assert_no_structured_stopless_control_fields(body, "provider.chat.sse");

    let observability = result
        .observability
        .as_ref()
        .expect("OpenAI Chat provider SSE result must expose observability");
    assert_eq!(observability.transport, "sse");
    assert_eq!(
        observability.response_status.as_deref(),
        Some("requires_action")
    );
    assert_eq!(observability.finish_reason.as_deref(), Some("tool_calls"));
    assert!(!observability.stopless_activation);
    let snapshot = result
        .stream_observation
        .as_ref()
        .expect("OpenAI Chat provider SSE result must expose stream observation")
        .snapshot()
        .unwrap();
    assert_eq!(snapshot.finish_reason.as_deref(), Some("tool_calls"));
    assert_eq!(snapshot.usage.as_ref().unwrap().total_tokens, Some(18));

    match result.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk.expect("projected OpenAI Chat provider SSE chunk"));
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(
                text.contains("event: response.completed"),
                "Responses client SSE must terminate OpenAI Chat tool-call projection with response.completed: {text}"
            );
            assert!(
                text.contains("event: response.done"),
                "Responses client SSE must emit response.done before the [DONE] transport marker: {text}"
            );
            assert!(
                !text.contains("event: response.requires_action"),
                "Responses client SSE must not use response.requires_action as terminal stream event: {text}"
            );
            assert!(
                text.contains("\"status\":\"requires_action\""),
                "Responses client SSE must preserve Hub canonical requires_action status through downstream framing: {text}"
            );
            assert!(
                text.contains("\"input_tokens\":11"),
                "Downstream SSE frame must carry Hub canonical input_tokens normalized from OpenAI Chat provider usage: {text}"
            );
            assert!(
                text.contains("\"output_tokens\":7"),
                "Downstream SSE frame must carry Hub canonical output_tokens normalized from OpenAI Chat provider usage: {text}"
            );
            assert!(
                !text.contains("\"prompt_tokens\""),
                "Downstream SSE frame must not reintroduce OpenAI Chat provider-wire prompt_tokens: {text}"
            );
            assert!(
                !text.contains("\"completion_tokens\""),
                "Downstream SSE frame must not reintroduce OpenAI Chat provider-wire completion_tokens: {text}"
            );
            assert!(
                text.contains("\"type\":\"reasoning\""),
                "Responses client SSE must project OpenAI Chat reasoning_content as a Responses reasoning output item: {text}"
            );
            assert!(
                text.contains("Need chat wire SSE before tool."),
                "Responses client SSE must preserve OpenAI Chat reasoning_content as replay-safe summary text: {text}"
            );
            assert!(
                !text.contains("reasoning_content"),
                "Responses client SSE must not leak OpenAI Chat provider-wire reasoning_content field: {text}"
            );
            let reasoning_pos = text
                .find("Need chat wire SSE before tool.")
                .expect("projected reasoning summary");
            let tool_pos = text.find("call_exec_sse").expect("projected tool call");
            assert!(
                reasoning_pos < tool_pos,
                "OpenAI Chat provider reasoning must remain before tool call in Responses client SSE: {text}"
            );
            assert!(
                text.contains("call_exec_sse"),
                "Responses client SSE must preserve the OpenAI Chat provider tool call: {text}"
            );
            assert!(
                !text.contains("call_stopless_reasoning"),
                "OpenAI Chat tool-call response must not be rewritten as stopless no-op: {text}"
            );
            assert!(
                text.contains("[DONE]"),
                "Responses client SSE must transport final done frame: {text}"
            );
            let completed = text
                .find("event: response.completed")
                .expect("response completed event");
            let done = text
                .find("event: response.done")
                .expect("response done event");
            let marker = text.find("data: [DONE]").expect("DONE marker");
            assert!(
                completed < done && done < marker,
                "Responses client SSE terminal ordering must be response.completed -> response.done -> [DONE]: {text}"
            );
            for forbidden in [
                "stopreason",
                "<rcc_stop_schema>",
                "repeatCount",
                "schemaFeedback",
                "triggerHint",
                "missingFields",
            ] {
                assert!(
                    !text.contains(forbidden),
                    "Responses client SSE leaked stopless control/schema artifact {forbidden}: {text}"
                );
            }
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("stream request must project SSE body"),
    }
    assert_eq!(state.len().unwrap(), 1);
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
capabilities = ["text", "tools", "tool_outputs", "local_materialization", "reasoning"]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_with_unsupported_provider_wire_target(
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let mut manifest = manifest();
    manifest
        .providers
        .get_mut("controlled")
        .expect("controlled provider")
        .provider_type = "unsupported-test-provider".to_string();
    manifest
}

fn manifest_openai_chat_wire() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.chatwire]
bind = "127.0.0.1"
port = 5555
routing_group = "chatwire"
endpoints = ["responses"]
[servers.chatwire.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
[providers.chatwire]
type = "openai_chat"
base_url = "http://chatwire.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.chatwire.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[route_groups.chatwire.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "chatwire", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_openai_chat_wire_with_responses_reselect(
) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.chatwire]
bind = "127.0.0.1"
port = 5555
routing_group = "chatwire"
endpoints = ["responses"]
[servers.chatwire.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
[providers.chatwire]
type = "openai_chat"
base_url = "http://chatwire.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.chatwire.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning"]
[providers.responseswire]
type = "responses"
base_url = "http://responseswire.invalid/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.responseswire.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "tool_outputs", "reasoning"]
[route_groups.chatwire.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "chatwire", model = "chat-wire-model", key = "controlled", priority = 1 },
  { kind = "provider_model", provider = "responseswire", model = "responses-wire-model", key = "controlled", priority = 2 }
]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}
