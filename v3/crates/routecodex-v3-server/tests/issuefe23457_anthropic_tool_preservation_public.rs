use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};
use tokio::sync::oneshot;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

const PROVIDER_KEY_ENV: &str = "FE23457_ANTHROPIC_PUBLIC_KEY";
const CALL_ID: &str = "toolu_fe23457_1";

struct TestHomeGuard {
    previous_home: Option<OsString>,
    previous_key: Option<OsString>,
    path: PathBuf,
    _environment_lock: MutexGuard<'static, ()>,
}

impl TestHomeGuard {
    fn new(test_name: &str) -> Self {
        // HOME and the provider-key environment are process-wide. Keep the
        // fixture environment scoped to one complete server lifetime under
        // the test runner's normal parallel selection. Each test owns a
        // distinct directory.
        let environment_lock = test_environment_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = std::env::temp_dir().join(format!(
            "routecodex-fe23457-anthropic-public-{}-{test_name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        let previous_home = std::env::var_os("HOME");
        let previous_key = std::env::var_os(PROVIDER_KEY_ENV);
        std::env::set_var("HOME", &path);
        std::env::set_var(PROVIDER_KEY_ENV, "fe23457-local-key");
        Self {
            previous_home,
            previous_key,
            path,
            _environment_lock: environment_lock,
        }
    }
}

fn test_environment_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous_home {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous_key {
            std::env::set_var(PROVIDER_KEY_ENV, previous);
        } else {
            std::env::remove_var(PROVIDER_KEY_ENV);
        }
        let _ = std::fs::remove_dir_all(&self.path);
        assert!(!self.path.exists(), "owned fixture home must be absent");
    }
}

#[derive(Clone, Default)]
struct ProviderState {
    captures: Arc<Mutex<Vec<Value>>>,
}

fn declaration_by_name<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
    body.get("tools")?
        .as_array()?
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
}

fn declaration_violations(body: &Value) -> Vec<String> {
    let mut violations = Vec::new();
    let expected = [
        (
            "DeferredToolPlaceholder",
            Some(true),
            Some(json!({"nested": {"keep": ["a", 7]}})),
        ),
        ("Bash", None, Some(json!("bash-local"))),
        ("ToolFalse", Some(false), Some(json!({"value": 0}))),
        ("ToolAbsent", None, None),
    ];
    for (name, expected_defer, expected_extension) in expected {
        let Some(declaration) = declaration_by_name(body, name) else {
            violations.push(format!("missing declaration {name}"));
            continue;
        };
        match expected_defer {
            Some(value) if declaration.get("defer_loading") != Some(&Value::Bool(value)) => {
                violations.push(format!(
                    "{name}.defer_loading expected {value}, got {:?}",
                    declaration.get("defer_loading")
                ));
            }
            None if declaration.get("defer_loading").is_some() => {
                violations.push(format!(
                    "{name}.defer_loading must remain absent, got {:?}",
                    declaration.get("defer_loading")
                ));
            }
            _ => {}
        }
        match expected_extension {
            Some(expected_value)
                if declaration.get("fe23457_extension") != Some(&expected_value) =>
            {
                violations.push(format!(
                    "{name}.fe23457_extension changed: {:?}",
                    declaration.get("fe23457_extension")
                ));
            }
            None if declaration.get("fe23457_extension").is_some() => {
                violations.push(format!(
                    "{name}.fe23457_extension must remain absent, got {:?}",
                    declaration.get("fe23457_extension")
                ));
            }
            _ => {}
        }
    }
    violations
}

fn provider_error(violations: &[String]) -> Response<Body> {
    let body = json!({
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": format!("strict fe23457 declaration fixture rejected: {}", violations.join("; "))
        }
    });
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn provider_text_response(text: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id": "msg_fe23457_final",
                "type": "message",
                "role": "assistant",
                "model": "fe23457-wire",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "stop_sequence": null,
                "usage": {"input_tokens": 10, "output_tokens": 3}
            }))
            .unwrap(),
        ))
        .unwrap()
}

async fn controlled_anthropic_provider(
    State(state): State<ProviderState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state.captures.lock().unwrap().push(body.clone());
    let violations = declaration_violations(&body);
    if !violations.is_empty() {
        return provider_error(&violations);
    }

    let has_tool_result = body
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages.iter().any(|message| {
                message
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|content| {
                        content.iter().any(|part| {
                            part.get("type").and_then(Value::as_str) == Some("tool_result")
                        })
                    })
            })
        });
    if has_tool_result {
        return provider_text_response("fe23457 follow-up complete");
    }

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({
                "id": "msg_fe23457_tool",
                "type": "message",
                "role": "assistant",
                "model": "fe23457-wire",
                "content": [{
                    "type": "tool_use",
                    "id": CALL_ID,
                    "name": "Bash",
                    "input": {"command": "printf 'fe23457-accept\\n'"}
                }],
                "stop_reason": "tool_use",
                "stop_sequence": null,
                "usage": {"input_tokens": 11, "output_tokens": 5}
            }))
            .unwrap(),
        ))
        .unwrap()
}

fn manifest(upstream_base_url: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}

[servers.fe23457]
bind = "127.0.0.1"
port = {server_port}
routing_group = "fe23457"
endpoints = ["anthropic"]
{server_execution}

[providers.fe23457]
type = "anthropic"
base_url = "{upstream_base_url}"
default_model = "fe23457-wire"
auth = {{ type = "api_key", entries = [{{ alias = "local", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.fe23457.models.fe23457-wire]
wire_name = "fe23457-wire"
aliases = ["fe23457-client"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.fe23457.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "anthropic", models = ["fe23457-client"] }}
targets = [{{ kind = "provider_model", provider = "fe23457", model = "fe23457-wire", key = "local", priority = 1 }}]

[route_groups.fe23457.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "fe23457", model = "fe23457-wire", key = "local", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_fixture::hub_v1_test_declaration(),
        server_port = test_ports::free_port(),
        server_execution = hub_v1_fixture::hub_v1_server_execution("fe23457"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

struct RunningFixture {
    endpoint: String,
    captures: Arc<Mutex<Vec<Value>>>,
    handle: routecodex_v3_server::V3ServerAggregateHandle,
    upstream_shutdown: oneshot::Sender<()>,
}

impl RunningFixture {
    async fn start() -> Self {
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let state = ProviderState::default();
        let captures = Arc::clone(&state.captures);
        let app = Router::new()
            .route("/v1/messages", post(controlled_anthropic_provider))
            .with_state(state);
        let (upstream_shutdown, shutdown_rx) = oneshot::channel();
        tokio::spawn(async move {
            axum::serve(upstream, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .unwrap();
        });
        let handle = spawn_v3_server_aggregate(manifest(&format!("http://{upstream_addr}")))
            .await
            .unwrap();
        let endpoint = format!("http://{}/v1/messages", handle.listeners[0].addr);
        Self {
            endpoint,
            captures,
            handle,
            upstream_shutdown,
        }
    }

    async fn stop(self) {
        self.handle.shutdown().await;
        let _ = self.upstream_shutdown.send(());
    }
}

fn tools() -> Value {
    json!([
        {
            "name": "DeferredToolPlaceholder",
            "description": "Reserved placeholder that keeps deferred tool loading active; never call this tool.",
            "input_schema": {"type": "object", "properties": {}},
            "defer_loading": true,
            "fe23457_extension": {"nested": {"keep": ["a", 7]}}
        },
        {
            "name": "Bash",
            "description": "Execute one exact local command.",
            "input_schema": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"]
            },
            "fe23457_extension": "bash-local"
        },
        {
            "name": "ToolFalse",
            "description": "A negative control.",
            "input_schema": {"type": "object", "properties": {}},
            "defer_loading": false,
            "fe23457_extension": {"value": 0}
        },
        {
            "name": "ToolAbsent",
            "description": "An absence control.",
            "input_schema": {"type": "object", "properties": {}}
        }
    ])
}

fn initial_request() -> Value {
    json!({
        "model": "fe23457-client",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": "Run the exact fe23457 local check."}],
        "tools": tools(),
        "stream": false
    })
}

async fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

#[tokio::test]
async fn fe23457_relay_preserves_complete_declarations_first_attempt() {
    let _guard = TestHomeGuard::new("complete-declarations");
    let fixture = RunningFixture::start().await;
    let client = http_client().await;
    let ingress = initial_request();
    let response_result = client.post(&fixture.endpoint).json(&ingress).send().await;
    let captures = fixture.captures.lock().unwrap().clone();
    assert_eq!(
        captures.len(),
        1,
        "one request must make one first provider attempt"
    );
    let violations = declaration_violations(&captures[0]);
    assert!(
        violations.is_empty(),
        "first provider declaration loss: {violations:?}"
    );
    let response = response_result.expect("public Anthropic Relay request must answer");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        captures[0]["tools"],
        tools(),
        "same-request declarations must reach the first provider attempt"
    );
    fixture.stop().await;
}

#[tokio::test]
async fn fe23457_relay_preserves_false_absent_and_distinct_tool_extensions() {
    let _guard = TestHomeGuard::new("false-absent-and-distinct-extensions");
    let fixture = RunningFixture::start().await;
    let client = http_client().await;
    let response = client
        .post(&fixture.endpoint)
        .json(&initial_request())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let captures = fixture.captures.lock().unwrap().clone();
    let body = captures.first().expect("first provider request capture");
    assert_eq!(
        body["tools"],
        tools(),
        "false, absence, and per-tool opaque values must remain exact"
    );
    fixture.stop().await;
}

#[tokio::test]
async fn fe23457_strict_provider_rejects_dropped_declaration_field() {
    let mut deficient = initial_request();
    deficient["tools"][0]
        .as_object_mut()
        .unwrap()
        .remove("defer_loading");
    let violations = declaration_violations(&deficient);
    assert!(
        violations
            .iter()
            .any(|violation| violation.contains("defer_loading")),
        "{violations:?}"
    );
}

#[tokio::test]
async fn fe23457_relay_preserves_tool_call_and_paired_result() {
    let _guard = TestHomeGuard::new("tool-call-and-paired-result");
    let fixture = RunningFixture::start().await;
    let client = http_client().await;
    let first = client
        .post(&fixture.endpoint)
        .json(&initial_request())
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: Value = first.json().await.unwrap();
    let tool_use = &first_body["content"][0];
    assert_eq!(tool_use["type"], "tool_use");
    assert_eq!(tool_use["id"], CALL_ID);
    assert_eq!(tool_use["name"], "Bash");
    assert_eq!(
        tool_use["input"],
        json!({"command": "printf 'fe23457-accept\\n'"})
    );

    let follow_up = client
        .post(&fixture.endpoint)
        .json(&json!({
            "model": "fe23457-client",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": "Run the exact fe23457 local check."},
                {"role": "assistant", "content": [tool_use.clone()]},
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": CALL_ID,
                        "content": "fe23457-accept\n",
                        "is_error": false
                    }]
                }
            ],
            "tools": tools(),
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(follow_up.status(), StatusCode::OK);
    let follow_up_body: Value = follow_up.json().await.unwrap();
    assert_eq!(
        follow_up_body["content"][0]["text"],
        "fe23457 follow-up complete"
    );

    let captures = fixture.captures.lock().unwrap().clone();
    assert_eq!(
        captures.len(),
        2,
        "initial and follow-up request must reach the first provider attempt"
    );
    let follow_up_capture = &captures[1];
    assert_eq!(
        follow_up_capture["tools"],
        tools(),
        "follow-up declarations must remain exact"
    );
    let assistant = &follow_up_capture["messages"][1]["content"][0];
    assert_eq!(assistant["type"], "tool_use");
    assert_eq!(assistant["id"], CALL_ID);
    assert_eq!(assistant["name"], "Bash");
    assert_eq!(
        assistant["input"],
        json!({"command": "printf 'fe23457-accept\\n'"})
    );
    let tool_result = &follow_up_capture["messages"][2]["content"][0];
    assert_eq!(tool_result["type"], "tool_result");
    assert_eq!(tool_result["tool_use_id"], CALL_ID);
    assert_eq!(tool_result["content"], "fe23457-accept\n");
    assert_eq!(tool_result["is_error"], false);
    fixture.stop().await;
}
