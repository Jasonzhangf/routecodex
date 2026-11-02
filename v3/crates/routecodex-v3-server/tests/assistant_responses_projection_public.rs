//! Strict public-entry regression for aa8d483. No live providers are contacted.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
static LOCK: AsyncMutex<()> = AsyncMutex::const_new(());
const TEXT: &str = " preserved assistant history \n";
const ARGUMENTS: &str = r#"{"a":17,"b":25}"#;

struct Home {
    previous: Option<OsString>,
    path: std::path::PathBuf,
}
impl Home {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("rcc-aa8d483-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}

fn validate(body: &Value) -> Result<bool, &'static str> {
    let input = body["input"].as_array().ok_or("input is required")?;
    let assistant = input
        .iter()
        .find(|item| {
            item["role"] == "assistant"
                && item["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["text"] == TEXT))
        })
        .ok_or("complete assistant history missing")?;
    let part = assistant["content"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| part["text"] == TEXT)
        .unwrap();
    if part["type"] != "output_text" {
        return Err("input is required");
    }
    if part["annotations"] != json!([]) {
        return Err("assistant annotations missing");
    }
    if !body["tools"].as_array().is_some_and(|tools| {
        tools
            .iter()
            .any(|tool| tool["type"] == "function" && tool["name"] == "acceptance_add")
    }) {
        return Err("tool declaration missing");
    }
    if !input.iter().any(|item| {
        item["type"] == "function_call"
            && item["call_id"] == "call_history"
            && item["arguments"] == r#"{"a":1,"b":2}"#
    }) {
        return Err("history call missing");
    }
    if !input.iter().any(|item| {
        item["type"] == "function_call_output"
            && item["call_id"] == "call_history"
            && item["output"] == "3"
    }) {
        return Err("history result missing");
    }
    let followup = input
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == "call_execute");
    if let Some(item) = followup {
        if item["output"] != "42" {
            return Err("actual client computation missing");
        }
    }
    Ok(followup.is_some())
}

async fn upstream(
    State(captures): State<Arc<Mutex<Vec<Value>>>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let validation = validate(&body);
    if let Err(reason) = validation {
        eprintln!("strict Responses fixture rejected: {reason}; body={body}");
    }
    captures.lock().unwrap().push(body);
    let followup = match validation {
        Ok(value) => value,
        Err(message) => return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"type":"invalid_request_error","param":"input","message":message}})
                    .to_string(),
            ))
            .unwrap(),
    };
    let mut output = vec![
        json!({"type":"reasoning","id":"rs_summary","summary":[{"type":"summary_text","text":"Controlled source completed this turn."}]}),
    ];
    if followup {
        output.push(json!({"type":"message","id":"msg_final","role":"assistant","status":"completed","content":[{"type":"output_text","text":"computed 42"}]}));
    } else {
        output.push(json!({"type":"function_call","id":"fc_execute","call_id":"call_execute","name":"acceptance_add","arguments":ARGUMENTS,"status":"completed"}));
    }
    Response::builder().status(StatusCode::OK).header("content-type","application/json").body(Body::from(json!({"id":if followup {"resp_final"} else {"resp_tool"},"object":"response","status":"completed","model":"wire","output":output,"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":20}}).to_string())).unwrap()
}

fn declaration(direct: bool, chat: bool) -> String {
    let mut value = hub_v1_fixture::hub_v1_test_declaration();
    if !direct && !chat {
        value = value.replace(
            r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#,
            r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#);
    }
    if chat {
        value = value.replace(
            r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#,
            r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#);
    }
    value
}

async fn roundtrip(direct: bool, chat: bool) {
    let _lock = LOCK.lock().await;
    let _home = Home::new();
    std::env::set_var("AA8D483_KEY", "controlled-secret");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let captures = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(captures.clone());
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });
    let source = format!(
        r#"
version = 3
{}
[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses", "openai_chat"]
[servers.a.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
[providers.strict]
type = "responses"
base_url = "http://{addr}/v1"
default_model = "wire"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "AA8D483_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.strict.models.wire]
wire_name = "wire"
aliases = ["client"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "strict", model = "wire", key = "key", priority = 1 }}]
"#,
        declaration(direct, chat),
        test_ports::free_port()
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let server = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let history = json!([
        {"type":"message","role":"user","content":[{"type":"input_text","text":"history"}]},
        {"type":"message","role":"assistant","content":[{"type":"output_text","text":TEXT,"annotations":[]}]},
        {"type":"function_call","id":"fc_history","call_id":"call_history","name":"acceptance_add","arguments":"{\"a\":1,\"b\":2}"},
        {"type":"function_call_output","call_id":"call_history","output":"3"},
        {"type":"message","role":"user","content":[{"type":"input_text","text":"compute 17+25"}]}
    ]);
    let mut request = if chat {
        json!({"model":"wire","stream":false,"messages":[
        {"role":"user","content":"history"},
        {"role":"assistant","content":[{"type":"text","text":TEXT,"annotations":[]}],"tool_calls":[{"id":"call_history","type":"function","function":{"name":"acceptance_add","arguments":"{\"a\":1,\"b\":2}"}}]},
        {"role":"tool","tool_call_id":"call_history","content":"3"},
        {"role":"user","content":"compute 17+25"}
    ],"tools":[{"type":"function","function":{"name":"acceptance_add","parameters":{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"]}}}]})
    } else {
        json!({"model":"wire","stream":false,"input":history,"tools":[{"type":"function","name":"acceptance_add","parameters":{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"]}}]})
    };
    // Counterexample validates the exact HTTP fixture, independently of RCC.
    let bad = json!({"input":[{"role":"assistant","content":[{"type":"text","text":TEXT}]}]});
    let rejected = client
        .post(format!("http://{addr}/v1/responses"))
        .json(&bad)
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), reqwest::StatusCode::BAD_REQUEST);
    captures.lock().unwrap().clear();
    let endpoint = format!(
        "http://{}{}",
        server.listeners[0].addr,
        if chat {
            "/v1/chat/completions"
        } else {
            "/v1/responses"
        }
    );
    let response = client.post(&endpoint).json(&request).send().await;
    let result = async move {
        let response = response.expect("public entry must deliver a business response");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let first: Value = response.json().await.expect("complete tool response");
        let call = if chat {
            first["choices"][0]["message"]["tool_calls"][0].clone()
        } else {
            first["output"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["type"] == "function_call")
                .unwrap()
                .clone()
        };
        let (id, name, arguments) = if chat {
            (
                call["id"].as_str().unwrap(),
                call["function"]["name"].as_str().unwrap(),
                call["function"]["arguments"].as_str().unwrap(),
            )
        } else {
            (
                call["call_id"].as_str().unwrap(),
                call["name"].as_str().unwrap(),
                call["arguments"].as_str().unwrap(),
            )
        };
        assert_eq!(name, "acceptance_add");
        assert_eq!(id, "call_execute");
        assert_eq!(arguments, ARGUMENTS);
        let args: Value = serde_json::from_str(arguments).unwrap();
        let computed = (args["a"].as_i64().unwrap() + args["b"].as_i64().unwrap()).to_string();
        assert_eq!(computed, "42");
        if chat {
            request["messages"]
                .as_array_mut()
                .unwrap()
                .push(first["choices"][0]["message"].clone());
            request["messages"]
                .as_array_mut()
                .unwrap()
                .push(json!({"role":"tool","tool_call_id":id,"content":computed}));
        } else {
            request["input"].as_array_mut().unwrap().push(call.clone());
            request["input"]
                .as_array_mut()
                .unwrap()
                .push(json!({"type":"function_call_output","call_id":id,"output":computed}));
        }
        let final_response = client.post(&endpoint).json(&request).send().await.unwrap();
        assert_eq!(final_response.status(), reqwest::StatusCode::OK);
        let final_body: Value = final_response.json().await.unwrap();
        if chat {
            assert_eq!(final_body["choices"][0]["finish_reason"], "stop");
            assert_eq!(final_body["choices"][0]["message"]["role"], "assistant");
            assert_eq!(
                final_body["choices"][0]["message"]["content"],
                "computed 42"
            );
        } else {
            assert_eq!(final_body["status"], "completed");
            let message = final_body["output"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["type"] == "message" && item["role"] == "assistant")
                .expect("final completed assistant message");
            assert_eq!(message["status"], "completed");
            assert_eq!(message["content"].as_array().unwrap().len(), 1);
            assert_eq!(message["content"][0]["type"], "output_text");
            assert_eq!(message["content"][0]["text"], "computed 42");
        }
        let attempts = captures.lock().unwrap();
        assert_eq!(
            attempts.len(),
            2,
            "exactly one provider attempt per client turn"
        );
        assert_eq!(validate(&attempts[0]), Ok(false));
        assert_eq!(validate(&attempts[1]), Ok(true));
    };
    // Ensure test-owned servers are closed even when a strict acceptance assertion fails.
    let outcome = tokio::spawn(result).await;
    server.shutdown().await;
    let _ = shutdown.send(());
    task.await.unwrap();
    outcome.unwrap();
}

#[tokio::test]
async fn aa8d483_responses_relay_assistant_output_text_tool_roundtrip() {
    roundtrip(false, false).await;
}
#[tokio::test]
async fn aa8d483_chat_to_responses_assistant_output_text_tool_roundtrip() {
    roundtrip(false, true).await;
}
#[tokio::test]
async fn aa8d483_responses_direct_preserves_output_text_tool_roundtrip() {
    roundtrip(true, false).await;
}
