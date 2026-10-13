//! Public-entry black box for namespace identity on a Responses client with
//! Gemini and Anthropic targets.
//!
//! Each target enters through the real HTTP `/v1/responses` endpoint of a
//! spawned aggregate server and reaches one locally spawned controlled
//! upstream. The upstream records the request it actually received, derives its
//! answer from those declarations, and refuses to answer when a required
//! declaration is missing. The test then checks the client-visible identity and
//! the declaration/choice/history agreement on the provider request. No live
//! provider is contacted.

use axum::{
    body::Body,
    extract::State,
    http::{StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{collections::HashMap, ffi::OsString, path::PathBuf, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

#[path = "support/gemini_signature_filter_public.rs"]
mod gemini_signature_filter_public;

const ORDINARY_NAMESPACE: &str = "plain_namespace";
const NESTED_NAMESPACE: &str = "nested__inner__deeper";
const FUNCTION_LEAF: &str = "_leading_underscore_leaf";
const CUSTOM_LEAF: &str = "_leading_underscore_custom";
const FUNCTION_DESCRIPTION: &str = "local arithmetic evaluator";
const CUSTOM_DESCRIPTION: &str = "local custom evaluator";
const ISOLATION_A: &str = "isolation_alpha";
const ISOLATION_B: &str = "isolation_beta";
const ISOLATION_LEAF: &str = "_isolation_leaf";
const ISOLATION_DESCRIPTION: &str = "isolation evaluator";
const UNDECLARED_NAMESPACE: &str = "declared_context";
const UNDECLARED_LEAF: &str = "_undeclared_leaf";
const UNDECLARED_DESCRIPTION: &str = "undeclared evaluator";
const FUNCTION_ARGUMENTS: &str =
    r#"{"left":19,"right":23,"note":"complete arguments on the wire"}"#;
const CUSTOM_INPUT: &str = "19+23";

/// The aggregate server persists debug samples under `$HOME/.rcc`. Point HOME
/// at a temporary directory so a sandboxed run never touches the operator's
/// live sample tree.
struct TestHomeGuard {
    previous: Option<OsString>,
    previous_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-namespace-public-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        let previous_key = std::env::var_os("V3_NAMESPACE_PUBLIC_KEY");
        std::env::set_var("HOME", &path);
        std::env::set_var("V3_NAMESPACE_PUBLIC_KEY", "fixture-key");
        Self {
            previous,
            previous_key,
            path,
        }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous_key {
            std::env::set_var("V3_NAMESPACE_PUBLIC_KEY", previous);
        } else {
            std::env::remove_var("V3_NAMESPACE_PUBLIC_KEY");
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Gemini,
    Anthropic,
}

impl Target {
    fn label(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::Anthropic => "anthropic",
        }
    }

    fn client_model(self) -> &'static str {
        match self {
            Self::Gemini => "gemini-namespace-client",
            Self::Anthropic => "anthropic-namespace-client",
        }
    }

    fn wire_model(self) -> &'static str {
        match self {
            Self::Gemini => "gemini-namespace-wire",
            Self::Anthropic => "anthropic-namespace-wire",
        }
    }
}

fn client_tools() -> Value {
    json!([
        {
            "type": "namespace",
            "name": ORDINARY_NAMESPACE,
            "tools": [
                {
                    "type": "function",
                    "name": FUNCTION_LEAF,
                    "description": FUNCTION_DESCRIPTION,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "left": {"type": "integer"},
                            "right": {"type": "integer"}
                        },
                        "required": ["left", "right"],
                        "additionalProperties": false
                    }
                }
            ]
        },
        {
            "type": "namespace",
            "name": NESTED_NAMESPACE,
            "tools": [
                {
                    "type": "custom",
                    "name": CUSTOM_LEAF,
                    "description": CUSTOM_DESCRIPTION,
                    "format": {"type": "text"}
                }
            ]
        }
    ])
}

fn single_function_tools(namespace: &str, leaf: &str, description: &str) -> Value {
    json!([
        {
            "type": "namespace",
            "name": namespace,
            "tools": [
                {
                    "type": "function",
                    "name": leaf,
                    "description": description,
                    "parameters": {"type": "object", "properties": {}}
                }
            ]
        }
    ])
}

fn first_turn_request(target: Target) -> Value {
    json!({
        "model": target.client_model(),
        "stream": false,
        "input": [{"role": "user", "content": "run the namespace round trip"}],
        "tools": client_tools(),
        "tool_choice": {"type": "function", "name": format!("{ORDINARY_NAMESPACE}.{FUNCTION_LEAF}")}
    })
}

fn isolation_request(target: Target, namespace: &str, marker: &str) -> Value {
    json!({
        "model": target.client_model(),
        "stream": false,
        "input": [{"role": "user", "content": marker}],
        "tools": single_function_tools(namespace, ISOLATION_LEAF, ISOLATION_DESCRIPTION),
        "tool_choice": {"type": "function", "name": format!("{namespace}.{ISOLATION_LEAF}")}
    })
}

fn undeclared_request(target: Target) -> Value {
    json!({
        "model": target.client_model(),
        "stream": false,
        "input": [{"role": "user", "content": "undeclared probe"}],
        "tools": single_function_tools(UNDECLARED_NAMESPACE, UNDECLARED_LEAF, UNDECLARED_DESCRIPTION),
        "tool_choice": {"type": "function", "name": format!("{UNDECLARED_NAMESPACE}.{UNDECLARED_LEAF}")}
    })
}

/// A plain tool whose name is exactly the wire name that the previous request
/// produced for `isolation_alpha`. A request-scoped inverse must keep it plain;
/// a leaked inverse would split it back into a namespace it never declared.
fn leaked_inverse_request(target: Target) -> Value {
    let leaked_wire_name = format!("{ISOLATION_A}__{ISOLATION_LEAF}");
    json!({
        "model": target.client_model(),
        "stream": false,
        "input": [{"role": "user", "content": "isolation probe"}],
        "tools": [{
            "type": "function",
            "name": leaked_wire_name,
            "description": ISOLATION_DESCRIPTION,
            "parameters": {"type": "object", "properties": {}}
        }],
        "tool_choice": {"type": "function", "name": leaked_wire_name}
    })
}

#[derive(Clone)]
struct UpstreamState {
    target: Target,
    captures: mpsc::UnboundedSender<Value>,
}

async fn controlled_upstream(
    State(state): State<UpstreamState>,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    if state.target == Target::Gemini
        && !uri.path().contains(":generateContent")
        && !uri.path().contains(":streamGenerateContent")
    {
        return not_found();
    }
    state
        .captures
        .send(json!({
            "target": state.target.label(),
            "path": uri.path(),
            "body": body.clone(),
            "same_source_violations": upstream_violations(state.target, &body),
        }))
        .unwrap();
    let declared = declared_wire_names(&body);
    let violations = upstream_violations(state.target, &body);
    if !violations.is_empty() {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":violations.join("; ")}}).to_string(),
            ))
            .unwrap();
    }
    if state.target == Target::Gemini && request_marker(&body).contains("prompt block") {
        return gemini_signature_filter_public::blocked_response(&body, &uri);
    }
    if state.target == Target::Gemini
        && uri.path().contains(":streamGenerateContent")
        && has_tool_result(&body)
    {
        return gemini_signature_filter_public::stream_followup();
    }
    if state.target == Target::Gemini && uri.path().contains(":streamGenerateContent") {
        return gemini_stream_response(&declared);
    }
    if state.target == Target::Gemini
        && !has_tool_result(&body)
        && request_marker(&body).contains("malformed control")
    {
        return ok_json(
            json!({"responseId":"malformed_provider","candidates":[{"index":0,"finishReason":"STOP","content":{"parts":[
                {"functionCall":{"id":"malformed_function","name":declared[FUNCTION_DESCRIPTION],"args":"{malformed"}},
                {"functionCall":{"id":"malformed_custom","name":declared[CUSTOM_DESCRIPTION],"args":{"extra":["complete"]}}}
            ]}}]}),
        );
    }
    if state.target == Target::Gemini && request_marker(&body).contains("filter control") {
        return ok_json(
            json!({"candidates":[{"index":0,"finishReason":"SAFETY"}],"usageMetadata":{"totalTokenCount":5}}),
        );
    }
    if body["stream"].as_bool() == Some(true) && state.target == Target::Anthropic {
        return anthropic_stream_response(state.target, &declared);
    }
    answer_from_declarations(state.target, &body, &declared)
}

fn gemini_stream_response(declared: &HashMap<String, String>) -> Response<Body> {
    let function = declared.get(FUNCTION_DESCRIPTION).unwrap();
    let custom = declared.get(CUSTOM_DESCRIPTION).unwrap();
    let frames = [
        json!({"responseId":"gemini_sse","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"namespace calls"}]}}]}),
        json!({"responseId":"gemini_sse","candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"name":function,"args":serde_json::from_str::<Value>(FUNCTION_ARGUMENTS).unwrap()},"thoughtSignature":"opaque/function/+=="}]}}]}),
        json!({"responseId":"gemini_sse","candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"name":custom,"args":{"input":CUSTOM_INPUT}},"thoughtSignature":"opaque/custom/+=="}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}),
    ];
    let text = frames
        .into_iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect::<String>();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(text))
        .unwrap()
}

/// Anthropic streaming wire: the argument JSON arrives in several partial
/// `input_json_delta` frames. The client-facing completed item must carry the
/// full accumulated arguments.
fn anthropic_stream_response(target: Target, declared: &HashMap<String, String>) -> Response<Body> {
    let function = declared
        .get(FUNCTION_DESCRIPTION)
        .cloned()
        .unwrap_or_default();
    let body = format!(
        "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"{}\",\"content\":[],\"stop_reason\":null}}}}\n\n\
event: content_block_start\ndata: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"tool_use\",\"id\":\"toolu_sse_function\",\"name\":\"{function}\",\"input\":{{}}}}}}\n\n\
event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":\"{{\\\"left\\\":19,\"}}}}\n\n\
event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"right\\\":23,\"}}}}\n\n\
event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"note\\\":\\\"complete arguments on the wire\\\"}}\"}}}}\n\n\
event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
event: message_delta\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"tool_use\"}},\"usage\":{{\"output_tokens\":5}}}}\n\n\
event: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n",
        target.wire_model()
    );
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

fn declared_wire_names(body: &Value) -> HashMap<String, String> {
    let mut declared = HashMap::new();
    for tool in body["tools"].as_array().cloned().unwrap_or_default() {
        if let Some(functions) = tool.get("functionDeclarations").and_then(Value::as_array) {
            for function in functions {
                if let (Some(description), Some(name)) =
                    (function["description"].as_str(), function["name"].as_str())
                {
                    declared.insert(base_description(description), name.into());
                }
            }
            continue;
        }
        let description = base_description(tool["description"].as_str().unwrap_or_default());
        let name = tool["name"].as_str().unwrap_or_default().to_string();
        if !description.is_empty() && !name.is_empty() {
            declared.entry(description).or_insert(name);
        }
    }
    declared
}

/// Provider compatibility may append a wrapper note to a description. Match the
/// declaration by its declared base description so the answer still comes from
/// the wire name the provider actually received.
fn base_description(description: &str) -> String {
    for base in [
        FUNCTION_DESCRIPTION,
        CUSTOM_DESCRIPTION,
        ISOLATION_DESCRIPTION,
        UNDECLARED_DESCRIPTION,
    ] {
        if description.starts_with(base) {
            return base.to_string();
        }
    }
    description.to_string()
}

/// Answers only from the declarations the upstream actually received. A missing
/// declaration is a hard error, so the upstream never fabricates an
/// unconditional 200 answer.
fn answer_from_declarations(
    target: Target,
    body: &Value,
    declared: &HashMap<String, String>,
) -> Response<Body> {
    if has_tool_result(body) {
        return json_response(target, declared, ResponseShape::Text);
    }
    if request_marker(body).contains("ordinary text control") {
        return json_response(target, declared, ResponseShape::Text);
    }
    if request_marker(body).contains("undeclared") {
        return json_response(target, declared, ResponseShape::Undeclared);
    }
    if request_marker(body).contains("isolation") {
        return json_response(target, declared, ResponseShape::Isolation);
    }
    if !declared.contains_key(FUNCTION_DESCRIPTION) || !declared.contains_key(CUSTOM_DESCRIPTION) {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error": {"message": "required namespace declarations were not projected"}})
                    .to_string(),
            ))
            .unwrap();
    }
    json_response(target, declared, ResponseShape::Calls)
}

#[derive(Clone, Copy)]
enum ResponseShape {
    Calls,
    Isolation,
    Undeclared,
    Text,
}

fn json_response(
    target: Target,
    declared: &HashMap<String, String>,
    shape: ResponseShape,
) -> Response<Body> {
    let call = |description: &str, arguments: Value| -> Value {
        let name = declared.get(description).cloned().unwrap_or_default();
        match target {
            Target::Anthropic => {
                json!({"type": "tool_use", "id": format!("toolu_{}", description.len()), "name": name, "input": arguments})
            }
            Target::Gemini => {
                let mut part = json!({"functionCall": {"name": name, "args": arguments}});
                if let Some(signature) = gemini_signature_filter_public::signature(description) {
                    part["thoughtSignature"] = json!(signature);
                }
                part
            }
        }
    };
    match target {
        Target::Anthropic => {
            let mut content = Vec::new();
            let mut stop_reason = "tool_use";
            match shape {
                ResponseShape::Calls => {
                    content.push(call(
                        FUNCTION_DESCRIPTION,
                        serde_json::from_str::<Value>(FUNCTION_ARGUMENTS).unwrap(),
                    ));
                    content.push(call(CUSTOM_DESCRIPTION, json!({"input": CUSTOM_INPUT})));
                    content.push(json!({"type": "text", "text": "namespace calls"}));
                }
                ResponseShape::Isolation => {
                    content.push(call(ISOLATION_DESCRIPTION, json!({})));
                }
                ResponseShape::Undeclared => {
                    content.push(json!({
                        "type": "tool_use",
                        "id": "toolu_undeclared",
                        "name": UNDECLARED_LEAF,
                        "input": {}
                    }));
                }
                ResponseShape::Text => {
                    content.push(json!({"type": "text", "text": "namespace follow up"}));
                    stop_reason = "end_turn";
                }
            }
            ok_json(json!({
                "id": "msg_namespace",
                "type": "message",
                "role": "assistant",
                "model": target.wire_model(),
                "content": content,
                "stop_reason": stop_reason
            }))
        }
        Target::Gemini => {
            let mut parts = Vec::new();
            match shape {
                ResponseShape::Calls => {
                    parts.push(call(
                        FUNCTION_DESCRIPTION,
                        serde_json::from_str::<Value>(FUNCTION_ARGUMENTS).unwrap(),
                    ));
                    parts.push(call(CUSTOM_DESCRIPTION, json!({"input": CUSTOM_INPUT})));
                }
                ResponseShape::Isolation => {
                    parts.push(call(ISOLATION_DESCRIPTION, json!({})));
                }
                ResponseShape::Undeclared => {
                    parts.push(json!({"functionCall": {"name": UNDECLARED_LEAF, "args": {}}}));
                }
                ResponseShape::Text => {
                    parts.push(json!({"text": "namespace follow up"}));
                }
            }
            ok_json(json!({
                "candidates": [{
                    "index": 0,
                    "finishReason": "STOP",
                    "content": {"role": "model", "parts": parts}
                }],
                "usageMetadata": {
                    "promptTokenCount": 3,
                    "candidatesTokenCount": 2,
                    "totalTokenCount": 5
                }
            }))
        }
    }
}

fn not_found() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .unwrap()
}

fn ok_json(value: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}

fn forced_choice_name(target: Target, body: &Value) -> Option<String> {
    match target {
        Target::Gemini => body
            .pointer("/toolConfig/functionCallingConfig/allowedFunctionNames")
            .and_then(Value::as_array)
            .and_then(|names| names.first())
            .and_then(Value::as_str)
            .map(str::to_string),
        Target::Anthropic => body
            .pointer("/tool_choice/name")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn history_call_names(body: &Value) -> Vec<String> {
    let mut names = Vec::new();
    for root in ["messages", "contents"] {
        if let Some(value) = body.get(root) {
            collect_call_names(value, &mut names);
        }
    }
    names
}

fn collect_call_names(value: &Value, names: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("tool_use") {
                if let Some(name) = map.get("name").and_then(Value::as_str) {
                    names.push(name.to_string());
                }
            }
            if let Some(call) = map.get("functionCall") {
                if let Some(name) = call.get("name").and_then(Value::as_str) {
                    names.push(name.to_string());
                }
            }
            if let Some(calls) = map.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        names.push(name.to_string());
                    }
                }
            }
            for value in map.values() {
                collect_call_names(value, names);
            }
        }
        Value::Array(items) => {
            for value in items {
                collect_call_names(value, names);
            }
        }
        _ => {}
    }
}

fn request_marker(body: &Value) -> String {
    let mut marker = String::new();
    for root in ["messages", "contents"] {
        if let Some(value) = body.get(root) {
            collect_text(value, &mut marker);
        }
    }
    marker
}

fn collect_text(value: &Value, text: &mut String) {
    match value {
        Value::Object(map) => {
            if let Some(part) = map.get("text").and_then(Value::as_str) {
                text.push_str(part);
            }
            if let Some(part) = map.get("content").and_then(Value::as_str) {
                text.push_str(part);
            }
            for value in map.values() {
                collect_text(value, text);
            }
        }
        Value::Array(items) => {
            for value in items {
                collect_text(value, text);
            }
        }
        _ => {}
    }
}

fn has_tool_result(body: &Value) -> bool {
    ["messages", "contents"]
        .iter()
        .filter_map(|root| body.get(root))
        .any(contains_tool_result)
}

fn contains_tool_result(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("tool_result")
                || map.get("role").and_then(Value::as_str) == Some("tool")
                || map.contains_key("functionResponse")
            {
                return true;
            }
            map.values().any(contains_tool_result)
        }
        Value::Array(items) => items.iter().any(contains_tool_result),
        _ => false,
    }
}

fn upstream_violations(target: Target, body: &Value) -> Vec<String> {
    let mut violations = Vec::new();
    if target == Target::Gemini {
        if body.get("messages").is_some() || !body.get("contents").is_some_and(Value::is_array) {
            violations
                .push("Gemini standard request requires contents and no Chat messages".into());
        }
        if body["tools"].as_array().into_iter().flatten().any(|tool| {
            !tool
                .get("functionDeclarations")
                .is_some_and(Value::is_array)
        }) {
            violations.push("Gemini tools require functionDeclarations, no flat tools".into());
        }
        let mut calls = HashMap::new();
        for content in body["contents"].as_array().into_iter().flatten() {
            for part in content["parts"].as_array().into_iter().flatten() {
                if let Some(call) = part.get("functionCall") {
                    gemini_signature_filter_public::check_history_signature(
                        body,
                        part,
                        &mut violations,
                    );
                    if let Some(id) = call["id"].as_str() {
                        calls.insert(id.to_string(), call["name"].clone());
                    }
                }
                if let Some(result) = part.get("functionResponse") {
                    if result["id"].as_str().and_then(|id| calls.get(id)) != Some(&result["name"]) {
                        violations.push(format!(
                            "Gemini result must match its actual call id and name: {result}"
                        ));
                    }
                    if result["response"]["output"] != "42"
                        && result["response"]["output"] != "client argument error"
                    {
                        violations.push(format!(
                            "Gemini result must preserve the consumer output string: {result}"
                        ));
                    }
                }
            }
        }
    }
    let declared = declared_wire_names(body);
    let declared_names = declared.values().cloned().collect::<Vec<_>>();
    if let Some(forced) = forced_choice_name(target, body) {
        if !declared_names.contains(&forced) {
            violations.push(format!(
                "{} forced choice {forced:?} is not one of the declared wire names {declared_names:?}",
                target.label()
            ));
        }
    }
    for name in history_call_names(body) {
        if !declared_names.contains(&name) {
            violations.push(format!(
                "{} history call {name:?} is not one of the declared wire names {declared_names:?}",
                target.label()
            ));
        }
    }
    violations
}

fn captured_violations(capture: &Value) -> Vec<String> {
    capture["same_source_violations"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|violation| violation.as_str().map(str::to_string))
        .collect()
}

async fn spawn_upstream(
    target: Target,
) -> (String, mpsc::UnboundedReceiver<Value>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1beta/models/:operation", post(controlled_upstream))
        .route("/v1/messages", post(controlled_upstream))
        .with_state(UpstreamState {
            target,
            captures: captures_tx,
        });
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let base_url = match target {
        Target::Gemini => format!("http://{address}/v1beta"),
        Target::Anthropic => format!("http://{address}"),
    };
    (base_url, captures_rx, shutdown_tx)
}

fn manifest(
    target: Target,
    server_port: u16,
    upstream_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let hub_v1_declaration =
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}

[servers.namespace]
bind = "127.0.0.1"
port = {server_port}
routing_group = "namespace"
endpoints = ["responses"]
{server_execution}

[providers.namespace]
type = "{provider_type}"
base_url = "{upstream_base_url}"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_NAMESPACE_PUBLIC_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}

[providers.namespace.models.{wire_model}]
wire_name = "{wire_model}"
aliases = ["{client_model}"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.namespace.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["{client_model}"] }}
targets = [{{ kind = "provider_model", provider = "namespace", model = "{wire_model}", key = "controlled", priority = 1 }}]

[route_groups.namespace.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "namespace", model = "{wire_model}", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_fixture::hub_v1_server_execution("namespace"),
        provider_type = target.label(),
        upstream_base_url = upstream_base_url,
        wire_model = target.wire_model(),
        client_model = target.client_model(),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

async fn send(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &Value,
) -> Result<(StatusCode, String), String> {
    let response = client
        .post(endpoint)
        .json(payload)
        .send()
        .await
        .map_err(|error| format!("public Responses entry did not answer: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("public Responses entry body was unreadable: {error}"))?;
    Ok((status, text))
}

fn parsed(status: StatusCode, text: &str) -> Result<Value, String> {
    if status != StatusCode::OK {
        return Err(format!("public Responses entry returned {status}: {text}"));
    }
    serde_json::from_str(text).map_err(|error| format!("client body was not JSON: {error}: {text}"))
}

fn sse_events(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| *data != "[DONE]")
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect()
}

fn output_items(body: &Value) -> Result<Vec<Value>, String> {
    body["output"].as_array().cloned().ok_or_else(|| {
        format!("a Responses client must receive Responses output items, got: {body}")
    })
}

fn item<'a>(items: &'a [Value], item_type: &str) -> Option<&'a Value> {
    items.iter().find(|item| item["type"] == item_type)
}

fn check_calls(body: &Value, violations: &mut Vec<String>) {
    let items = match output_items(body) {
        Ok(items) => items,
        Err(error) => {
            violations.push(error);
            return;
        }
    };
    match item(&items, "function_call") {
        Some(call) => {
            if call["namespace"] != ORDINARY_NAMESPACE {
                violations.push(format!(
                    "function_call namespace must be restored to {ORDINARY_NAMESPACE:?}, got {call}"
                ));
            }
            if call["name"] != FUNCTION_LEAF {
                violations.push(format!(
                    "function_call name must be restored to {FUNCTION_LEAF:?}, got {call}"
                ));
            }
            if call["call_id"].as_str().unwrap_or_default().is_empty() {
                violations.push(format!("function_call must carry a call id, got {call}"));
            }
            let expected: Value = serde_json::from_str(FUNCTION_ARGUMENTS).unwrap();
            let actual = call["arguments"]
                .as_str()
                .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok());
            if actual.as_ref() != Some(&expected) {
                violations.push(format!(
                    "function_call arguments must be the complete provider arguments {expected}, got {call}"
                ));
            }
        }
        None => violations.push(format!("client output must expose a function_call: {body}")),
    }
    match item(&items, "custom_tool_call") {
        Some(call) => {
            if call["namespace"] != NESTED_NAMESPACE {
                violations.push(format!(
                    "custom_tool_call namespace must be restored to {NESTED_NAMESPACE:?}, got {call}"
                ));
            }
            if call["name"] != CUSTOM_LEAF {
                violations.push(format!(
                    "custom_tool_call name must be restored to {CUSTOM_LEAF:?}, got {call}"
                ));
            }
            if call["input"] != CUSTOM_INPUT {
                violations.push(format!(
                    "custom_tool_call input must be {CUSTOM_INPUT:?}, got {call}"
                ));
            }
            if call["call_id"].as_str().unwrap_or_default().is_empty() {
                violations.push(format!("custom_tool_call must carry a call id, got {call}"));
            }
        }
        None => violations.push(format!(
            "client output must expose a custom_tool_call: {body}"
        )),
    }
}

fn execute_consumer(call: &Value) -> String {
    let output = match call["type"].as_str().unwrap() {
        "function_call" => {
            assert_eq!(call["namespace"], ORDINARY_NAMESPACE);
            assert_eq!(call["name"], FUNCTION_LEAF);
            let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
            args["left"].as_i64().unwrap() + args["right"].as_i64().unwrap()
        }
        "custom_tool_call" => {
            assert_eq!(call["namespace"], NESTED_NAMESPACE);
            assert_eq!(call["name"], CUSTOM_LEAF);
            let (left, right) = call["input"].as_str().unwrap().split_once('+').unwrap();
            left.parse::<i64>().unwrap() + right.parse::<i64>().unwrap()
        }
        _ => panic!("unsupported local consumer kind"),
    };
    eprintln!(
        "EVIDENCE_CONSUMER_RECEIPT call_id={} output={output}",
        call["call_id"]
    );
    output.to_string()
}

async fn capture(captures: &mut mpsc::UnboundedReceiver<Value>) -> Result<Value, String> {
    match tokio::time::timeout(Duration::from_secs(5), captures.recv()).await {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err("upstream capture channel closed".to_string()),
        Err(_) => Err("controlled upstream never received the request".to_string()),
    }
}

async fn request(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &Value,
    captures: &mut mpsc::UnboundedReceiver<Value>,
    label: &str,
) -> (Result<(StatusCode, String), String>, Option<Value>) {
    let client_result = send(client, endpoint, payload).await;
    let captured = match capture(captures).await {
        Ok(capture) => {
            eprintln!("EVIDENCE_{label}_UPSTREAM={}", capture["body"]);
            Some(capture)
        }
        Err(error) => {
            eprintln!("EVIDENCE_{label}_UPSTREAM_MISSING={error}");
            None
        }
    };
    (client_result, captured)
}

async fn collect(target: Target) -> Vec<String> {
    let mut violations = Vec::new();
    let (base_url, mut captures, upstream_shutdown) = spawn_upstream(target).await;
    let handle = spawn_v3_server_aggregate(manifest(target, test_ports::free_port(), &base_url))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = http_client();

    // 1. First attempt with a function and a custom namespace declaration.
    let (first_result, first_capture) = request(
        &client,
        &endpoint,
        &first_turn_request(target),
        &mut captures,
        &format!("{}_FIRST", target.label()),
    )
    .await;
    let mut first_items = None;
    match first_result {
        Ok((status, text)) => match parsed(status, &text) {
            Ok(body) => {
                eprintln!("EVIDENCE_{}_FIRST_CLIENT={body}", target.label());
                check_calls(&body, &mut violations);
                first_items = output_items(&body).ok();
            }
            Err(error) => violations.push(error),
        },
        Err(error) => violations.push(error),
    }
    if let Some(capture) = first_capture {
        violations.extend(captured_violations(&capture));
    }

    // 2. Paired follow-up with the exact client-visible calls.
    let calls = first_items
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            matches!(
                item["type"].as_str(),
                Some("function_call" | "custom_tool_call")
            )
        })
        .collect::<Vec<_>>();
    if let (Some(function_call), Some(custom_call)) = (
        item(&calls, "function_call").cloned(),
        item(&calls, "custom_tool_call").cloned(),
    ) {
        let mut input = vec![json!({"role": "user", "content": "follow up the namespace calls"})];
        input.extend(calls.iter().cloned());
        input.push(json!({
            "type": "function_call_output",
            "call_id": function_call["call_id"],
            "output": execute_consumer(&function_call)
        }));
        input.push(json!({
            "type": "custom_tool_call_output",
            "call_id": custom_call["call_id"],
            "output": execute_consumer(&custom_call)
        }));
        let followup = json!({
            "model": target.client_model(),
            "stream": false,
            "input": input,
            "tools": client_tools(),
            "tool_choice": {"type": "function", "name": format!("{ORDINARY_NAMESPACE}.{FUNCTION_LEAF}")}
        });
        let (followup_result, followup_capture) = request(
            &client,
            &endpoint,
            &followup,
            &mut captures,
            &format!("{}_FOLLOWUP", target.label()),
        )
        .await;
        match followup_result {
            Ok((status, text)) => match parsed(status, &text) {
                Ok(followup_body) => {
                    let text_present = followup_body["output"].as_array().is_some_and(|items| {
                        items.iter().any(|item| {
                            item["type"] == "message"
                                || item["type"] == "output_text"
                                || item["content"].as_array().is_some_and(|parts| {
                                    parts
                                        .iter()
                                        .any(|part| part["text"] == "namespace follow up")
                                })
                        })
                    });
                    if !text_present {
                        violations.push(format!(
                            "paired follow-up must complete with provider business content: {followup_body}"
                        ));
                    }
                }
                Err(error) => violations.push(format!("follow-up: {error}")),
            },
            Err(error) => violations.push(format!("follow-up: {error}")),
        }
        if let Some(capture) = followup_capture {
            violations.extend(captured_violations(&capture));
        }
    } else {
        violations.push(
            "the first attempt did not expose both a function_call and a custom_tool_call, so the paired follow-up could not run"
                .to_string(),
        );
    }

    // 2b. A streaming completion must carry the full arguments. The provider
    // deltas are partial, so the completed item is the authoritative value.
    {
        let mut payload = first_turn_request(target);
        payload["stream"] = json!(true);
        let (sse_result, sse_capture) = request(
            &client,
            &endpoint,
            &payload,
            &mut captures,
            &format!("{}_SSE", target.label()),
        )
        .await;
        match sse_result {
            Ok((status, text)) => {
                if status != StatusCode::OK {
                    violations.push(format!("SSE attempt returned {status}: {text}"));
                } else {
                    eprintln!("EVIDENCE_{}_SSE_CLIENT={text}", target.label());
                    let events = sse_events(&text);
                    if target == Target::Gemini {
                        match events
                            .iter()
                            .find(|event| event["type"] == "response.completed")
                        {
                            Some(event) => {
                                check_calls(&event["response"], &mut violations);
                                if event["response"]["usage"]["total_tokens"] != 5 {
                                    violations.push(format!(
                                        "Gemini SSE must retain terminal usage: {event}"
                                    ));
                                }
                                for call in event["response"]["output"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter(|call| {
                                        matches!(
                                            call["type"].as_str(),
                                            Some("function_call" | "custom_tool_call")
                                        )
                                    })
                                {
                                    let added = events.iter().find(|event| {
                                        event["type"] == "response.output_item.added"
                                            && event["item"]["call_id"] == call["call_id"]
                                    });
                                    let done = events.iter().find(|event| {
                                        event["type"] == "response.output_item.done"
                                            && event["item"]["call_id"] == call["call_id"]
                                    });
                                    if !added.is_some_and(|event| {
                                        event["item"]["name"] == call["name"]
                                            && event["item"]["namespace"] == call["namespace"]
                                            && event["item"]["type"] == call["type"]
                                    }) || !done.is_some_and(|event| event["item"] == *call)
                                    {
                                        violations.push(format!("Gemini SSE added/done/terminal identity and complete input must agree: {call}"));
                                    }
                                    assert_eq!(execute_consumer(call), "42");
                                }
                                let calls: Vec<_> = event["response"]["output"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .filter(|call| {
                                        matches!(
                                            call["type"].as_str(),
                                            Some("function_call" | "custom_tool_call")
                                        )
                                    })
                                    .cloned()
                                    .collect();
                                let mut input = vec![
                                    json!({"role":"user","content":"follow up streaming calls"}),
                                ];
                                input.extend(calls.clone());
                                input.extend(calls.iter().map(|call| json!({"type":if call["type"] == "custom_tool_call" {"custom_tool_call_output"} else {"function_call_output"},"call_id":call["call_id"],"output":execute_consumer(call)})));
                                let followup = json!({"model":target.client_model(),"stream":false,"tools":client_tools(),"input":input});
                                let (result, capture) = request(
                                    &client,
                                    &endpoint,
                                    &followup,
                                    &mut captures,
                                    "gemini_SSE_FOLLOWUP",
                                )
                                .await;
                                if !result.is_ok_and(|(status, text)| {
                                    parsed(status, &text)
                                        .is_ok_and(|body| body["output"].is_array())
                                }) {
                                    violations
                                        .push("Gemini SSE consumer follow-up must complete".into());
                                }
                                if let Some(capture) = capture {
                                    violations.extend(captured_violations(&capture));
                                }
                            }
                            None => violations
                                .push("Gemini SSE must complete with a Responses terminal".into()),
                        }
                    }
                    let done_item = events
                        .iter()
                        .find(|event| {
                            event["type"] == "response.output_item.done"
                                && event["item"]["type"] == "function_call"
                        })
                        .map(|event| event["item"].clone())
                        .or_else(|| {
                            events
                                .iter()
                                .find(|event| event["type"] == "response.completed")
                                .and_then(|event| event["response"]["output"].as_array())
                                .and_then(|items| {
                                    items.iter().find(|item| item["type"] == "function_call")
                                })
                                .cloned()
                        });
                    match done_item {
                        Some(call) => {
                            if call["namespace"] != ORDINARY_NAMESPACE
                                || call["name"] != FUNCTION_LEAF
                            {
                                violations.push(format!(
                                    "SSE completed function_call identity must be restored, got {call}"
                                ));
                            }
                            let expected: Value = serde_json::from_str(FUNCTION_ARGUMENTS).unwrap();
                            let actual = call["arguments"].as_str().and_then(|arguments| {
                                serde_json::from_str::<Value>(arguments).ok()
                            });
                            if actual.as_ref() != Some(&expected) {
                                violations.push(format!(
                                    "SSE completed item must carry the complete arguments {expected}, got {call}"
                                ));
                            }
                        }
                        None => violations.push(format!(
                            "SSE completion must expose the function_call item: {text}"
                        )),
                    }
                }
            }
            Err(error) => violations.push(format!("SSE attempt: {error}")),
        }
        if let Some(capture) = sse_capture {
            violations.extend(captured_violations(&capture));
        }
    }

    // 3. Two requests that share the same leaf must not share an inverse grant.
    for namespace in [ISOLATION_A, ISOLATION_B] {
        let (isolation_result, isolation_capture) = request(
            &client,
            &endpoint,
            &isolation_request(target, namespace, "isolation probe"),
            &mut captures,
            &format!("{}_ISOLATION_{namespace}", target.label()),
        )
        .await;
        match isolation_result {
            Ok((status, text)) => match parsed(status, &text) {
                Ok(body) => {
                    match output_items(&body)
                        .ok()
                        .and_then(|items| item(&items, "function_call").cloned())
                    {
                        Some(call) => {
                            if call["namespace"] != namespace {
                                violations.push(format!(
                                    "request for {namespace:?} must restore its own namespace, got {call}"
                                ));
                            }
                        }
                        None => violations.push(format!(
                            "isolation request for {namespace:?} must expose a function_call: {body}"
                        )),
                    }
                }
                Err(error) => {
                    violations.push(format!("isolation request for {namespace:?}: {error}"))
                }
            },
            Err(error) => violations.push(format!("isolation request for {namespace:?}: {error}")),
        }
        if let Some(capture) = isolation_capture {
            violations.extend(captured_violations(&capture));
        }
    }

    // 3b. A later request that declares only a plain tool named exactly like the
    // previous request's wire name must not inherit that request's namespace.
    let leaked_wire_name = format!("{ISOLATION_A}__{ISOLATION_LEAF}");
    let (leak_result, leak_capture) = request(
        &client,
        &endpoint,
        &leaked_inverse_request(target),
        &mut captures,
        &format!("{}_LEAKED_INVERSE", target.label()),
    )
    .await;
    match leak_result {
        Ok((status, text)) => match parsed(status, &text) {
            Ok(body) => {
                eprintln!("EVIDENCE_{}_LEAKED_INVERSE_CLIENT={body}", target.label());
                match output_items(&body)
                    .ok()
                    .and_then(|items| item(&items, "function_call").cloned())
                {
                    Some(call) => {
                        if call["name"] != leaked_wire_name {
                            violations.push(format!(
                                "a plain tool named {leaked_wire_name:?} must stay plain, got {call}"
                            ));
                        }
                        if call.get("namespace").is_some() {
                            violations.push(format!(
                                "a previous request's namespace must not be granted to a later plain request, got {call}"
                            ));
                        }
                    }
                    None => violations.push(format!(
                        "leaked-inverse request must expose a function_call: {body}"
                    )),
                }
            }
            Err(error) => violations.push(format!("leaked-inverse request: {error}")),
        },
        Err(error) => violations.push(format!("leaked-inverse request: {error}")),
    }
    if let Some(capture) = leak_capture {
        violations.extend(captured_violations(&capture));
    }

    // 4. A provider name that was never declared must reach the client unchanged.
    let (undeclared_result, undeclared_capture) = request(
        &client,
        &endpoint,
        &undeclared_request(target),
        &mut captures,
        &format!("{}_UNDECLARED", target.label()),
    )
    .await;
    match undeclared_result {
        Ok((status, text)) => match parsed(status, &text) {
            Ok(body) => {
                match output_items(&body)
                    .ok()
                    .and_then(|items| item(&items, "function_call").cloned())
                {
                    Some(call) => {
                        if call["name"] != UNDECLARED_LEAF {
                            violations.push(format!(
                                "undeclared name must reach the client unchanged as {UNDECLARED_LEAF:?}, got {call}"
                            ));
                        }
                        if call.get("namespace").is_some() {
                            violations.push(format!(
                                "an undeclared name must not gain an invented namespace, got {call}"
                            ));
                        }
                    }
                    None => violations.push(format!(
                        "undeclared request must expose a function_call: {body}"
                    )),
                }
            }
            Err(error) => violations.push(format!("undeclared request: {error}")),
        },
        Err(error) => violations.push(format!("undeclared request: {error}")),
    }
    if let Some(capture) = undeclared_capture {
        violations.extend(captured_violations(&capture));
    }

    if target == Target::Gemini {
        let plain =
            json!({"model":target.client_model(),"input":"ordinary text control","stream":false});
        let (result, capture) =
            request(&client, &endpoint, &plain, &mut captures, "gemini_ORDINARY").await;
        match result {
            Ok((status, text)) => match parsed(status, &text) {
                Ok(body) => {
                    if body.get("candidates").is_some()
                        || !body["output"].as_array().is_some_and(|items| {
                            items
                                .iter()
                                .any(|item| item["content"][0]["text"] == "namespace follow up")
                        })
                    {
                        violations.push(format!("ordinary Gemini business response must use the Responses client shape: {body}"));
                    }
                    if body["usage"]["total_tokens"] != 5 {
                        violations.push(format!("ordinary Gemini usage must survive: {body}"));
                    }
                }
                Err(error) => violations.push(error),
            },
            Err(error) => violations.push(error),
        }
        if let Some(capture) = capture {
            violations.extend(captured_violations(&capture));
        }
        let mut malformed = first_turn_request(target);
        malformed["input"] = json!("malformed control");
        let (result, capture) = request(
            &client,
            &endpoint,
            &malformed,
            &mut captures,
            "gemini_MALFORMED",
        )
        .await;
        let (status, text) = result.unwrap();
        let body = parsed(status, &text).unwrap();
        let calls = output_items(&body).unwrap();
        assert_eq!(
            item(&calls, "function_call").unwrap()["arguments"],
            "{malformed"
        );
        assert_eq!(
            item(&calls, "custom_tool_call").unwrap()["input"],
            r#"{"extra":["complete"]}"#
        );
        assert_eq!(
            item(&calls, "function_call").unwrap()["call_id"],
            "malformed_function"
        );
        assert_eq!(
            item(&calls, "custom_tool_call").unwrap()["call_id"],
            "malformed_custom"
        );
        if let Some(capture) = capture {
            violations.extend(captured_violations(&capture));
        }
        let mut input = calls.clone();
        input.extend(calls.iter().map(|call| json!({"type":if call["type"] == "custom_tool_call" {"custom_tool_call_output"} else {"function_call_output"},"call_id":call["call_id"],"output":"client argument error"})));
        malformed["input"] = json!(input);
        let (result, capture) = request(
            &client,
            &endpoint,
            &malformed,
            &mut captures,
            "gemini_CORRECTION",
        )
        .await;
        let (status, text) = result.unwrap();
        assert!(parsed(status, &text).unwrap()["output"].is_array());
        if let Some(capture) = capture {
            violations.extend(captured_violations(&capture));
        }
        let filtered =
            json!({"model":target.client_model(),"input":"filter control","stream":false});
        let (result, capture) = request(
            &client,
            &endpoint,
            &filtered,
            &mut captures,
            "gemini_FILTER",
        )
        .await;
        let (status, text) = result.unwrap();
        let filtered = parsed(status, &text).unwrap();
        assert_eq!(filtered["status"], "incomplete");
        assert_eq!(filtered["incomplete_details"]["reason"], "content_filter");
        if let Some(capture) = capture {
            violations.extend(captured_violations(&capture));
        }
    }
    handle.shutdown().await;
    upstream_shutdown.send(()).unwrap();
    violations
}

#[tokio::test]
async fn responses_client_reaches_gemini_and_anthropic_namespace_targets() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("cross-protocol");
    let mut violations = Vec::new();
    for target in [Target::Gemini, Target::Anthropic] {
        let target_violations = collect(target).await;
        eprintln!(
            "EVIDENCE_{}_VIOLATIONS={:?}",
            target.label(),
            target_violations
        );
        violations.extend(
            target_violations
                .into_iter()
                .map(|violation| format!("[{}] {violation}", target.label())),
        );
    }
    assert!(
        violations.is_empty(),
        "namespace round trip violations:\n{}",
        violations.join("\n")
    );
}
