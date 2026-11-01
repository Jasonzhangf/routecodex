//! Public-entry black box for complete Gemini SSE attempt buffering.
//!
//! Stable test ID:
//! `gemini_sse_complete_attempt_buffering_and_late_error_public` (run with
//! `cargo test -p routecodex-v3-server --test gemini_sse_attempt_public`).
//!
//! The test enters through the real HTTP `/v1/responses` endpoint of a spawned
//! aggregate server and reaches one locally spawned controlled Gemini upstream.
//! The upstream emits strict standard Gemini SSE chunks in separate transport
//! chunks and refuses to answer unless the request carries the standard Gemini
//! shape. No live provider is contacted.
//!
//! It covers the confirmed P1#3 finding: the Responses Relay Gemini
//! materializer must consume the complete provider attempt to real EOF, track
//! each candidate terminal independently, preserve later candidate content and
//! usage, and propagate a typed late provider error before any successful
//! business payload is committed to the client.

use axum::{
    body::Body,
    extract::State,
    http::{StatusCode, Uri},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::StreamExt;
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

const CLIENT_MODEL: &str = "gemini-sse-client";
const WIRE_MODEL: &str = "gemini-sse-wire";
const NAMESPACE: &str = "sse_namespace";
const LEAF: &str = "_sse_leaf";
const DESCRIPTION: &str = "sse complete attempt evaluator";
const FUNCTION_ARGUMENTS: &str = r#"{"left":17,"right":25,"note":"later candidate arguments"}"#;
const USAGE_TOTAL: u64 = 5;

/// The aggregate server persists debug samples under `$HOME/.rcc`. Point HOME
/// at a temporary directory so a sandboxed run never touches the operator's
/// live sample tree.
struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-gemini-sse-public-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn client_tools() -> Value {
    json!([
        {
            "type": "namespace",
            "name": NAMESPACE,
            "tools": [
                {
                    "type": "function",
                    "name": LEAF,
                    "description": DESCRIPTION,
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
        }
    ])
}

fn streaming_request(marker: &str) -> Value {
    json!({
        "model": CLIENT_MODEL,
        "stream": true,
        "input": [{"role": "user", "content": marker}],
        "tools": client_tools(),
        "tool_choice": {"type": "function", "name": format!("{NAMESPACE}.{LEAF}")}
    })
}

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<Value>,
}

async fn controlled_upstream(
    State(state): State<UpstreamState>,
    uri: Uri,
    Json(body): Json<Value>,
) -> Response<Body> {
    if !uri.path().contains(":streamGenerateContent") {
        return not_found();
    }
    let violations = gemini_violations(&body);
    state
        .captures
        .send(json!({
            "path": uri.path(),
            "body": body.clone(),
            "same_source_violations": violations,
        }))
        .unwrap();
    if !violations.is_empty() {
        return bad_request(&violations.join("; "));
    }
    let declared = declared_wire_names(&body);
    let marker = request_marker(&body);
    if has_tool_result(&body) {
        return gemini_sse(text_frame("sse follow up complete"));
    }
    if marker.contains("multi candidate") {
        return gemini_sse(multi_candidate_frames(&declared));
    }
    if marker.contains("late error") {
        return gemini_sse(late_error_frames());
    }
    if marker.contains("filter control") {
        return gemini_sse(filter_frame());
    }
    gemini_sse(text_frame("sse ordinary control"))
}

/// Candidate 0 terminates in the first chunk. Candidate 1 supplies a tool call
/// in a later chunk and only terminates in a third chunk that also carries the
/// usage. An early-returning materializer truncates the attempt after chunk one.
fn multi_candidate_frames(declared: &HashMap<String, String>) -> Vec<Value> {
    let function = declared.get(DESCRIPTION).cloned().unwrap_or_default();
    vec![
        json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"candidate zero"}]},"finishReason":"STOP"}]}),
        json!({"candidates":[{"index":1,"content":{"role":"model","parts":[{"functionCall":{"name":function,"args":serde_json::from_str::<Value>(FUNCTION_ARGUMENTS).unwrap()}}]}}]}),
        json!({"candidates":[{"index":1,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":USAGE_TOTAL}}),
    ]
}

/// A typed provider error frame after candidate 0 already terminated. The
/// materializer must keep reading, so the error reaches the typed Error chain
/// before any success commitment.
fn late_error_frames() -> Vec<Value> {
    vec![
        json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"committed candidate zero"}]},"finishReason":"STOP"}]}),
        json!({"error":{"code":"late_provider_error","message":"typed late provider error after terminal"}}),
    ]
}

/// A legal provider business terminal: the candidate reports its own content
/// filter. It stays a business response and must never enter provider-failure
/// recovery.
fn filter_frame() -> Vec<Value> {
    vec![
        json!({"candidates":[{"index":0,"finishReason":"SAFETY"}],"usageMetadata":{"totalTokenCount":USAGE_TOTAL}}),
    ]
}

fn text_frame(text: &str) -> Vec<Value> {
    vec![json!({
        "candidates": [{"index": 0, "content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 2, "totalTokenCount": USAGE_TOTAL}
    })]
}

fn gemini_sse(frames: Vec<Value>) -> Response<Body> {
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

fn declared_wire_names(body: &Value) -> HashMap<String, String> {
    let mut declared = HashMap::new();
    for tool in body["tools"].as_array().cloned().unwrap_or_default() {
        for function in tool
            .get("functionDeclarations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(description), Some(name)) =
                (function["description"].as_str(), function["name"].as_str())
            {
                declared.insert(base_description(description), name.into());
            }
        }
    }
    declared
}

/// Provider compatibility may append a wrapper note to a description. Match the
/// declaration by its declared base description so the answer still comes from
/// the wire name the provider actually received.
fn base_description(description: &str) -> String {
    if description.starts_with(DESCRIPTION) {
        DESCRIPTION.to_string()
    } else {
        description.to_string()
    }
}

fn forced_choice_name(body: &Value) -> Option<String> {
    body.pointer("/toolConfig/functionCallingConfig/allowedFunctionNames")
        .and_then(Value::as_array)
        .and_then(|names| names.first())
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn history_call_names(body: &Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(contents) = body.get("contents") {
        collect_call_names(contents, &mut names);
    }
    names
}

fn collect_call_names(value: &Value, names: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(call) = map.get("functionCall") {
                if let Some(name) = call.get("name").and_then(Value::as_str) {
                    names.push(name.to_string());
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
    if let Some(contents) = body.get("contents") {
        collect_text(contents, &mut marker);
    }
    marker
}

fn collect_text(value: &Value, text: &mut String) {
    match value {
        Value::Object(map) => {
            if let Some(part) = map.get("text").and_then(Value::as_str) {
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
    body.get("contents").is_some_and(contains_tool_result)
}

fn contains_tool_result(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if map.contains_key("functionResponse") {
                return true;
            }
            map.values().any(contains_tool_result)
        }
        Value::Array(items) => items.iter().any(contains_tool_result),
        _ => false,
    }
}

/// Strict Gemini standard request shape plus declaration/choice/history
/// agreement. A violation makes the upstream refuse the attempt, so a green
/// result cannot come from a fixture that tolerates a non-standard request.
fn gemini_violations(body: &Value) -> Vec<String> {
    let mut violations = Vec::new();
    if body.get("messages").is_some() || !body.get("contents").is_some_and(Value::is_array) {
        violations.push("Gemini standard request requires contents and no Chat messages".into());
    }
    if body["tools"].as_array().into_iter().flatten().any(|tool| {
        !tool
            .get("functionDeclarations")
            .is_some_and(Value::is_array)
    }) {
        violations.push("Gemini tools require functionDeclarations, no flat tools".into());
    }
    let declared = declared_wire_names(body);
    let declared_names = declared.values().cloned().collect::<Vec<_>>();
    if let Some(forced) = forced_choice_name(body) {
        if !declared_names.contains(&forced) {
            violations.push(format!(
                "Gemini forced choice {forced:?} is not one of the declared wire names {declared_names:?}"
            ));
        }
    }
    for name in history_call_names(body) {
        if !declared_names.contains(&name) {
            violations.push(format!(
                "Gemini history call {name:?} is not one of the declared wire names {declared_names:?}"
            ));
        }
    }
    for content in body["contents"].as_array().into_iter().flatten() {
        for part in content["parts"].as_array().into_iter().flatten() {
            if let Some(result) = part.get("functionResponse") {
                if !declared_names.iter().any(|name| result["name"] == *name) {
                    violations.push(format!(
                        "Gemini functionResponse must carry a declared wire name: {result}"
                    ));
                }
                if result["response"]["output"] != "42" {
                    violations.push(format!(
                        "Gemini functionResponse must preserve the consumer output: {result}"
                    ));
                }
            }
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

fn not_found() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::empty())
        .unwrap()
}

fn bad_request(message: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"error": {"message": message}}).to_string(),
        ))
        .unwrap()
}

async fn spawn_upstream() -> (String, mpsc::UnboundedReceiver<Value>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1beta/models/:operation", post(controlled_upstream))
        .with_state(UpstreamState {
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
    (format!("http://{address}/v1beta"), captures_rx, shutdown_tx)
}

fn manifest(
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

[servers.sse]
bind = "127.0.0.1"
port = {server_port}
routing_group = "sse"
endpoints = ["responses"]
{server_execution}

[providers.sse]
type = "gemini"
base_url = "{upstream_base_url}"
default_model = "{WIRE_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_GEMINI_SSE_PUBLIC_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}

[providers.sse.models.{WIRE_MODEL}]
wire_name = "{WIRE_MODEL}"
aliases = ["{CLIENT_MODEL}"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.sse.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "responses", models = ["{CLIENT_MODEL}"] }}
targets = [{{ kind = "provider_model", provider = "sse", model = "{WIRE_MODEL}", key = "controlled", priority = 1 }}]

[route_groups.sse.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "sse", model = "{WIRE_MODEL}", key = "controlled", priority = 1 }}]
"#,
        server_execution = hub_v1_fixture::hub_v1_server_execution("sse"),
    );
    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    // The failed last identity remains protected while the original request
    // waits. Declare this fixture's budget instead of relying on early close.
    manifest
        .servers
        .get_mut("sse")
        .unwrap()
        .execution
        .as_mut()
        .unwrap()
        .attempt_store
        .residence_timeout_ms = 3000;
    manifest
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

/// Streams the whole client body, including bytes that arrive before a broken
/// provider attempt terminates the transport. Reading the byte stream directly
/// (instead of `.text()`) keeps the earlier-success evidence visible even when
/// the transport closes without a terminal. A failure before the committed head
/// is returned as `Err` so the late-error case can treat it as a terminated
/// transport rather than a success.
async fn send_sse(
    client: &reqwest::Client,
    endpoint: &str,
    payload: &Value,
) -> Result<(StatusCode, String), String> {
    let response = client
        .post(endpoint)
        .json(payload)
        .send()
        .await
        .map_err(|error| format!("public Responses SSE entry did not answer: {error}"))?;
    let status = response.status();
    let mut body = response.bytes_stream();
    let mut received = Vec::new();
    let collect = async {
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(chunk) => received.extend_from_slice(&chunk),
                Err(_) => break,
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(15), collect)
        .await
        .expect("the committed SSE channel must terminate or complete");
    Ok((status, String::from_utf8_lossy(&received).into_owned()))
}

fn sse_events(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| *data != "[DONE]")
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect()
}

fn terminal_response(events: &[Value]) -> Option<&Value> {
    events.iter().find_map(|event| {
        matches!(
            event["type"].as_str(),
            Some("response.completed" | "response.incomplete")
        )
        .then(|| &event["response"])
    })
}

/// Drain every provider attempt for one request. Provider failure handling may
/// retry the same candidate, so collecting all captures keeps later scenarios
/// aligned on their own attempt.
async fn capture_all(captures: &mut mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
    let mut values = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(300), captures.recv()).await {
            Ok(Some(value)) => values.push(value),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    values
}

fn execute_consumer(call: &Value) -> String {
    assert_eq!(call["namespace"], NAMESPACE);
    assert_eq!(call["name"], LEAF);
    let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
    let output = args["left"].as_i64().unwrap() + args["right"].as_i64().unwrap();
    eprintln!(
        "EVIDENCE_CONSUMER_RECEIPT call_id={} output={output}",
        call["call_id"]
    );
    output.to_string()
}

#[tokio::test]
async fn gemini_sse_complete_attempt_buffering_and_late_error_public() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("attempt");
    std::env::set_var("V3_GEMINI_SSE_PUBLIC_KEY", "fixture-key");

    let mut violations = Vec::new();
    let (base_url, mut captures, upstream_shutdown) = spawn_upstream().await;
    let handle = spawn_v3_server_aggregate(manifest(test_ports::free_port(), &base_url))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = http_client();

    // 1. A multi-candidate attempt: candidate 0 terminates first, candidate 1
    // carries later content, and usage arrives after both terminals.
    let (status, text) = send_sse(
        &client,
        &endpoint,
        &streaming_request("multi candidate control"),
    )
    .await
    .unwrap_or_else(|error| panic!("multi-candidate SSE must commit a client head: {error}"));
    for capture in capture_all(&mut captures).await {
        violations.extend(captured_violations(&capture));
    }
    eprintln!("EVIDENCE_gemini_SSE_MULTI_CLIENT={text}");
    if status != StatusCode::OK {
        violations.push(format!("multi-candidate SSE returned {status}: {text}"));
    }
    let events = sse_events(&text);
    let mut function_call = None;
    match terminal_response(&events) {
        Some(response) => {
            eprintln!("EVIDENCE_gemini_SSE_MULTI_TERMINAL={response}");
            let items = response["output"].as_array().cloned().unwrap_or_default();
            let text_preserved = items.iter().any(|item| {
                item["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["text"] == "candidate zero"))
            });
            if !text_preserved {
                violations.push(format!(
                    "the first candidate text must survive complete buffering: {response}"
                ));
            }
            match items.iter().find(|item| item["type"] == "function_call") {
                Some(call) => {
                    if call["namespace"] != NAMESPACE {
                        violations.push(format!(
                            "later candidate namespace must be restored to {NAMESPACE:?}: {call}"
                        ));
                    }
                    if call["name"] != LEAF {
                        violations.push(format!(
                            "later candidate leaf must be restored to {LEAF:?}: {call}"
                        ));
                    }
                    let expected: Value = serde_json::from_str(FUNCTION_ARGUMENTS).unwrap();
                    let actual = call["arguments"]
                        .as_str()
                        .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok());
                    if actual.as_ref() != Some(&expected) {
                        violations.push(format!(
                            "later candidate arguments must be complete {expected}: {call}"
                        ));
                    }
                    function_call = Some(call.clone());
                }
                None => violations.push(format!(
                    "the later candidate function_call must reach the client: {response}"
                )),
            }
            if response["usage"]["total_tokens"] != USAGE_TOTAL {
                violations.push(format!(
                    "usage that arrives after the first terminal must survive: {response}"
                ));
            }
        }
        None => violations.push(format!(
            "the multi-candidate SSE attempt must complete: {text}"
        )),
    }

    // 1b. Paired follow-up using the exact client-visible call.
    if let Some(call) = function_call {
        let followup = json!({
            "model": CLIENT_MODEL,
            "stream": true,
            "input": [
                {"role": "user", "content": "follow up the later candidate call"},
                call.clone(),
                {
                    "type": "function_call_output",
                    "call_id": call["call_id"],
                    "output": execute_consumer(&call)
                }
            ],
            "tools": client_tools()
        });
        let (status, text) = send_sse(&client, &endpoint, &followup)
            .await
            .unwrap_or_else(|error| panic!("paired follow-up must commit a client head: {error}"));
        for capture in capture_all(&mut captures).await {
            violations.extend(captured_violations(&capture));
        }
        eprintln!("EVIDENCE_gemini_SSE_FOLLOWUP_CLIENT={text}");
        if status != StatusCode::OK {
            violations.push(format!("paired follow-up SSE returned {status}: {text}"));
        }
        let events = sse_events(&text);
        let completed = terminal_response(&events).is_some_and(|response| {
            response["output"].as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["content"].as_array().is_some_and(|parts| {
                        parts
                            .iter()
                            .any(|part| part["text"] == "sse follow up complete")
                    })
                })
            })
        });
        if !completed {
            violations.push(format!(
                "the paired follow-up must complete with provider business content: {text}"
            ));
        }
    }

    // 2. A typed late provider error after candidate 0 already terminated must
    // reach the typed Error chain before any client success commitment.
    let late_error_started = std::time::Instant::now();
    match send_sse(&client, &endpoint, &streaming_request("late error control")).await {
        Ok((status, text)) => {
            eprintln!("EVIDENCE_gemini_SSE_LATE_ERROR_CLIENT={text}");
            if status != StatusCode::OK {
                violations.push(format!("late-error SSE returned {status}: {text}"));
            }
            let events = sse_events(&text);
            if terminal_response(&events).is_some() {
                violations.push(format!(
                    "a typed late provider error must not commit an earlier success: {text}"
                ));
            }
            if text.contains("committed candidate zero") {
                violations.push(format!(
                    "no earlier candidate payload may reach the client before the late error: {text}"
                ));
            }
        }
        Err(error) => {
            eprintln!("EVIDENCE_gemini_SSE_LATE_ERROR_CLIENT_TERMINATED={error}");
        }
    }
    assert!(
        late_error_started.elapsed() >= Duration::from_millis(2500),
        "the failed last attempt cannot bypass its original recovery budget"
    );
    for capture in capture_all(&mut captures).await {
        violations.extend(captured_violations(&capture));
    }

    // 3. A provider content-filter terminal stays a legal business response.
    let (status, text) = send_sse(&client, &endpoint, &streaming_request("filter control"))
        .await
        .unwrap_or_else(|error| panic!("filter-control SSE must commit a client head: {error}"));
    for capture in capture_all(&mut captures).await {
        violations.extend(captured_violations(&capture));
    }
    eprintln!("EVIDENCE_gemini_SSE_FILTER_CLIENT={text}");
    if status != StatusCode::OK {
        violations.push(format!("filter-control SSE returned {status}: {text}"));
    }
    let events = sse_events(&text);
    match terminal_response(&events) {
        Some(response) => {
            if response["status"] != "incomplete"
                || response["incomplete_details"]["reason"] != "content_filter"
            {
                violations.push(format!(
                    "a provider content-filter terminal must stay a business response: {response}"
                ));
            }
        }
        None => violations.push(format!(
            "the content-filter terminal must complete the stream: {text}"
        )),
    }

    handle.shutdown().await;
    let _ = upstream_shutdown.send(());
    std::env::remove_var("V3_GEMINI_SSE_PUBLIC_KEY");
    assert!(
        violations.is_empty(),
        "Gemini SSE complete-attempt violations:\n{}",
        violations.join("\n")
    );
}
