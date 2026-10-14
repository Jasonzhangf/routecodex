//! Signed history must close every existing target projection, not only Gemini.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
static LOCK: Mutex<()> = Mutex::const_new(());
const FUNCTION_SIG: &str = "opaque/function/+==";
const CUSTOM_SIG: &str = "opaque/custom/different/+==";
const ARGS: &str = r#"{"left":19,"right":23}"#;

struct Home {
    path: PathBuf,
    previous: Option<std::ffi::OsString>,
    key: Option<std::ffi::OsString>,
}
impl Home {
    fn new(target: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "rcc-signature-target-{target}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        let previous = std::env::var_os("HOME");
        let key = std::env::var_os("V3_SIGNATURE_TARGET_KEY");
        std::env::set_var("HOME", &path);
        std::env::set_var("V3_SIGNATURE_TARGET_KEY", "fixture-key");
        Self {
            path,
            previous,
            key,
        }
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        for (name, value) in [
            ("HOME", &self.previous),
            ("V3_SIGNATURE_TARGET_KEY", &self.key),
        ] {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}

fn tools() -> Value {
    json!([
        {"type":"namespace","name":"math","tools":[{"type":"function","name":"sum","description":"signed-function","parameters":{"type":"object","properties":{"left":{"type":"integer"},"right":{"type":"integer"}}}}]},
        {"type":"namespace","name":"custom__nested","tools":[{"type":"custom","name":"sum","description":"signed-custom","format":{"type":"text"}}]}
    ])
}
fn calls() -> Vec<Value> {
    vec![
        json!({"type":"function_call","id":"fc_signed_function","call_id":"signed_function","namespace":"math","name":"sum","arguments":ARGS,"thought_signature":FUNCTION_SIG}),
        json!({"type":"custom_tool_call","id":"ct_signed_custom","call_id":"signed_custom","namespace":"custom__nested","name":"sum","input":"19+23","thought_signature":CUSTOM_SIG}),
        json!({"type":"function_call","id":"fc_unsigned","call_id":"unsigned","namespace":"math","name":"sum","arguments":ARGS}),
    ]
}
fn execute(call: &Value) -> String {
    let result = if call["type"] == "custom_tool_call" {
        assert_eq!(call["input"], "19+23");
        call["input"]
            .as_str()
            .unwrap()
            .split('+')
            .map(|n| n.parse::<i64>().unwrap())
            .sum::<i64>()
    } else {
        let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).unwrap();
        args["left"].as_i64().unwrap() + args["right"].as_i64().unwrap()
    };
    assert_eq!(result, 42);
    eprintln!(
        "CONSUMER_RECEIPT call_id={} result={result}",
        call["call_id"]
    );
    result.to_string()
}
fn request(calls: &[Value]) -> Value {
    let mut input = vec![json!({"role":"user","content":"signed history projection"})];
    input.extend(calls.iter().cloned());
    input.extend(calls.iter().map(|call| json!({"type":if call["type"] == "custom_tool_call" {"custom_tool_call_output"} else {"function_call_output"},"call_id":call["call_id"],"output":execute(call)})));
    json!({"model":"signature-client","stream":false,"tools":tools(),"input":input})
}
#[derive(Clone)]
struct Upstream {
    target: &'static str,
    captures: mpsc::UnboundedSender<Value>,
}

fn check(body: &Value, target: &str) -> Vec<String> {
    let mut errors = Vec::new();
    if target != "responses" {
        let wire = body.to_string();
        for forbidden in [
            FUNCTION_SIG,
            CUSTOM_SIG,
            "thought_signature",
            "routecodex_chat_extension",
        ] {
            if wire.contains(forbidden) {
                errors.push(format!(
                    "unrepresentable signature/control carrier on wire: {forbidden}"
                ));
            }
        }
    }
    let mut observed = Vec::new();
    match target {
        "responses" => {
            for item in body["input"].as_array().into_iter().flatten() {
                if matches!(
                    item["type"].as_str(),
                    Some("function_call" | "custom_tool_call")
                ) {
                    observed.push((
                        item["call_id"].clone(),
                        item["thought_signature"].clone(),
                        if item["type"] == "custom_tool_call" {
                            item["input"].clone()
                        } else {
                            item["arguments"].clone()
                        },
                    ));
                    if !body["input"].as_array().unwrap().iter().any(|output| {
                        output["call_id"] == item["call_id"] && output["output"] == "42"
                    }) {
                        errors.push(format!("missing paired consumer output: {item}"));
                    }
                }
            }
        }
        "anthropic" => {
            for message in body["messages"].as_array().into_iter().flatten() {
                for item in message["content"].as_array().into_iter().flatten() {
                    if item["type"] == "tool_use" {
                        observed.push((
                            item["id"].clone(),
                            item["thought_signature"].clone(),
                            item["input"].clone(),
                        ));
                        if !body["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .flat_map(|m| m["content"].as_array().into_iter().flatten())
                            .any(|output| {
                                output["tool_use_id"] == item["id"] && output["content"] == "42"
                            })
                        {
                            errors.push(format!("missing Anthropic paired output: {item}"));
                        }
                    }
                }
            }
        }
        _ => {
            for message in body["messages"].as_array().into_iter().flatten() {
                for item in message["tool_calls"].as_array().into_iter().flatten() {
                    observed.push((
                        item["id"].clone(),
                        item["thought_signature"].clone(),
                        item["function"]["arguments"].clone(),
                    ));
                    if !body["messages"].as_array().unwrap().iter().any(|output| {
                        output["tool_call_id"] == item["id"] && output["content"] == "42"
                    }) {
                        errors.push(format!("missing Chat paired output: {item}"));
                    }
                }
            }
        }
    }
    if observed.len() != 3 {
        errors.push(format!("expected three history calls, got {observed:?}"));
    }
    for (id, signature, arguments) in observed {
        let custom = id == "signed_custom";
        let expected = if target == "responses" {
            match id.as_str() {
                Some("signed_function") => json!(FUNCTION_SIG),
                Some("signed_custom") => json!(CUSTOM_SIG),
                _ => Value::Null,
            }
        } else {
            Value::Null
        };
        if signature != expected {
            errors.push(format!(
                "call-local signature {id}: got {signature}, expected {expected}"
            ));
        }
        let expected_arguments = if target == "anthropic" {
            if custom {
                json!({"input":"19+23"})
            } else {
                serde_json::from_str(ARGS).unwrap()
            }
        } else if custom {
            if target == "responses" {
                json!("19+23")
            } else {
                json!(r#"{"input":"19+23"}"#)
            }
        } else {
            json!(ARGS)
        };
        if arguments != expected_arguments {
            errors.push(format!(
                "arguments changed {id}: {arguments} vs {expected_arguments}"
            ));
        }
    }
    errors
}
async fn upstream(State(state): State<Upstream>, Json(body): Json<Value>) -> Response<Body> {
    let errors = check(&body, state.target);
    state
        .captures
        .send(json!({"body":body,"errors":errors}))
        .unwrap();
    if !errors.is_empty() {
        return Response::builder()
            .status(StatusCode::UNPROCESSABLE_ENTITY)
            .body(Body::from(json!({"errors":errors}).to_string()))
            .unwrap();
    }
    let response = match state.target {
        "responses" => {
            json!({"id":"resp_signature","object":"response","status":"completed","output":body["input"].as_array().unwrap().iter().filter(|item| matches!(item["type"].as_str(),Some("function_call" | "custom_tool_call"))).cloned().collect::<Vec<_>>()})
        }
        "anthropic" => {
            json!({"id":"msg_signature","type":"message","role":"assistant","model":"signature-wire","content":[{"type":"text","text":"projection accepted"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}})
        }
        _ => {
            json!({"id":"chat_signature","object":"chat.completion","model":"signature-wire","choices":[{"index":0,"message":{"role":"assistant","content":"projection accepted"},"finish_reason":"stop"}]})
        }
    };
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(response.to_string()))
        .unwrap()
}

async fn run(target: &'static str) {
    let _lock = LOCK.lock().await;
    let home = Home::new(target);
    let (captures, mut receiver) = mpsc::unbounded_channel();
    let (shutdown, shutdown_rx) = oneshot::channel::<()>();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .fallback(post(upstream))
                .with_state(Upstream { target, captures }),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let direct = declaration
        .lines()
        .find(|line| line.contains("entry_protocol = \"responses\""))
        .unwrap();
    let relay = r#"  { entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" },"#;
    let declaration = declaration.replace(direct, relay);
    let port = test_ports::free_port();
    let execution = hub_v1_fixture::hub_v1_server_execution("signature");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.signature]
bind = "127.0.0.1"
port = {port}
routing_group = "signature"
endpoints = ["responses"]
{execution}
[providers.signature]
type = "{target}"
base_url = "{base}"
default_model = "signature-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_SIGNATURE_TARGET_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.signature.models.signature-wire]
wire_name = "signature-wire"
aliases = ["signature-client"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.signature.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "signature", model = "signature-wire", key = "controlled", priority = 1 }}]
"#
    );
    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let log = home.path.join("projection-drops.jsonl");
    manifest.debug.projection_drop_log_file = Some(log.display().to_string());
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let result = client.post(&endpoint).json(&request(&calls())).send().await;
    let capture = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    eprintln!("SIGNATURE_TARGET_WIRE target={target} {capture}");
    let mut errors: Vec<String> = capture["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap().to_owned())
        .collect();
    if errors.is_empty() {
        let response = result.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response: Value = response.json().await.unwrap();
        eprintln!("SIGNATURE_TARGET_CLIENT target={target} {response}");
        if target == "responses" {
            let calls = response["output"].as_array().unwrap();
            assert_eq!(calls.len(), 3);
            for call in calls {
                let original = super_call(call);
                assert_eq!(call["thought_signature"], original["thought_signature"]);
                assert_eq!(call["namespace"], original["namespace"]);
                assert_eq!(call["name"], original["name"]);
                assert_eq!(call["type"], original["type"]);
                assert_eq!(execute(call), "42");
            }
            let followup = client
                .post(&endpoint)
                .json(&request(calls))
                .send()
                .await
                .unwrap();
            assert_eq!(followup.status(), StatusCode::OK);
            let followup: Value = followup.json().await.unwrap();
            assert_eq!(followup["status"], "completed");
            let capture = receiver.recv().await.unwrap();
            assert_eq!(capture["errors"], json!([]));
        } else {
            let records = std::fs::read_to_string(&log).unwrap_or_default();
            eprintln!("SIGNATURE_TARGET_DROP target={target} {records}");
            assert_eq!(response["status"], "completed");
            if target == "openai_chat" {
                // The declared Chat -> Responses codec emits output_text items.
                // Check its complete business text, not another codec's envelope.
                assert_eq!(
                    response["output"],
                    json!([{
                        "type":"output_text", "text":"projection accepted"
                    }])
                );
                assert_eq!(response["output_text"], "projection accepted");
            } else {
                assert_eq!(
                    response["output"],
                    json!([{
                        "type":"message", "role":"assistant",
                        "content":[{"type":"output_text", "text":"projection accepted"}]
                    }])
                );
            }
            for (index, signature) in [FUNCTION_SIG, CUSTOM_SIG].into_iter().enumerate() {
                if !records
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .any(|record| {
                        record["target_protocol"] == target
                            && record["canonical_value"] == signature
                            && record["json_path"]
                                .as_str()
                                .is_some_and(|p| p.ends_with(".thought_signature"))
                            && record["stage"] == "outbound_target_protocol_projection"
                            && record["json_path"]
                                == format!("$.messages[1].tool_calls[{index}].thought_signature")
                            && record["reason"] == "unmapped_target_protocol_field_unrepresentable"
                            && record["drop_site"]
                                == "project_outbound_payload_for_target_protocol_inner_with_drops"
                            && record["entry_port"] == port.to_string()
                            && record["request_id"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty())
                    })
                {
                    errors.push(format!("missing declared drop diagnostic for {signature}"));
                }
            }
        }
    }
    assert!(
        receiver.try_recv().is_err(),
        "optional business field must not trigger recovery/duplicate attempts"
    );
    handle.shutdown().await;
    shutdown.send(()).unwrap();
    task.await.unwrap();
    assert!(errors.is_empty(), "target {target}: {}", errors.join("\n"));
}
fn super_call(call: &Value) -> Value {
    calls()
        .into_iter()
        .find(|original| original["call_id"] == call["call_id"])
        .unwrap()
}

#[tokio::test]
async fn signed_namespace_history_responses_exact_projection_consumer() {
    run("responses").await;
}
#[tokio::test]
async fn signed_namespace_history_anthropic_declared_drop_diagnostic() {
    run("anthropic").await;
}
#[tokio::test]
async fn signed_namespace_history_chat_declared_drop_diagnostic() {
    run("openai_chat").await;
}
