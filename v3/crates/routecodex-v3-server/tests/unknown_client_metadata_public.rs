//! Public Responses -> Chat regression for issue 3759f5d.
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

const CALL: &str = "call_sum_3759f5d";
const ARGS: &str = r#"{"a":19,"b":23}"#;
const REFILL: &str =
    "继续执行尚未完成的任务；需要工具时直接调用工具；如果任务已完成，请给出完成总结。";

fn metadata() -> Value {
    json!({"user_id":"client-user-3759f5d", "session_id":"metadata-session",
        "x-codex-turn-metadata":"registered-local", "unknown":{"nested":true},
        "future.key":{"values":[1,"two"]}})
}

#[derive(Clone)]
struct Upstream {
    backup: bool,
    captures: Arc<Mutex<Vec<Value>>>,
}

fn validate(body: &Value) -> Result<&'static str, String> {
    if body["metadata"] != json!({"user_id":"client-user-3759f5d"}) {
        return Err(format!("metadata mapping/leak: {body}"));
    }
    for forbidden in [
        "client_metadata",
        "future.key",
        "nested",
        "registered-local",
        "metadata-session",
    ] {
        if body.to_string().contains(forbidden) {
            return Err(format!(
                "unsupported/local metadata on provider wire: {forbidden}"
            ));
        }
    }
    if body["model"] != "wire-model"
        || body["tools"][0]["function"]["name"] != "sum"
        || body["tools"][0]["function"]["parameters"]["properties"]["a"]["type"] != "integer"
        || body["tools"][0]["function"]["parameters"]["properties"]["b"]["type"] != "integer"
    {
        return Err(format!("model/tool declaration changed: {body}"));
    }
    let messages = body["messages"].as_array().ok_or("missing messages")?;
    let calls: Vec<_> = messages
        .iter()
        .flat_map(|m| m["tool_calls"].as_array().into_iter().flatten())
        .collect();
    let outputs: Vec<_> = messages.iter().filter(|m| m["role"] == "tool").collect();
    if calls.is_empty() && outputs.is_empty() {
        return Ok("initial");
    }
    if calls.len() != 1
        || outputs.len() != 1
        || calls[0]["id"] != CALL
        || calls[0]["function"]["name"] != "sum"
        || calls[0]["function"]["arguments"] != ARGS
        || outputs[0]["tool_call_id"] != CALL
        || outputs[0]["content"] != "42"
    {
        return Err(format!("tool history pairing/arguments changed: {body}"));
    }
    let call_index = messages
        .iter()
        .position(|m| m["tool_calls"].as_array().is_some_and(|c| !c.is_empty()))
        .unwrap();
    if messages.get(call_index + 1) != Some(outputs[0]) {
        return Err(format!("paired result order changed: {body}"));
    }
    let refill = messages
        .last()
        .is_some_and(|m| m["role"] == "user" && m["content"].to_string().contains(REFILL));
    if refill {
        if !messages.iter().any(|m| {
            m["role"] == "assistant" && m["content"].to_string().contains("sum accepted 42")
        }) {
            return Err(format!("refill missing accepted result: {body}"));
        }
        Ok("refill")
    } else {
        Ok("followup")
    }
}

async fn upstream(State(state): State<Upstream>, Json(body): Json<Value>) -> Response<Body> {
    let validation = validate(&body);
    let phase = validation.as_ref().copied().unwrap_or("rejected");
    state.captures.lock().unwrap().push(json!({"identity":if state.backup {"backup"} else {"primary"},"phase":phase,"body":body,"error":validation.as_ref().err()}));
    if state.backup || validation.is_err() {
        return Response::builder().status(StatusCode::BAD_REQUEST).header("content-type","application/json")
            .body(Body::from(json!({"error":{"message":validation.err().unwrap_or("unexpected backup attempt".into())}}).to_string())).unwrap();
    }
    let message = if phase == "initial" {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":CALL,"type":"function","function":{"name":"sum","arguments":ARGS}}]})
    } else {
        json!({"role":"assistant","content":if phase == "refill" {"refill accepted"} else {"sum accepted 42"}})
    };
    let finish = if phase == "initial" {
        "tool_calls"
    } else {
        "stop"
    };
    let choice = if body["stream"] == true {
        json!({"index":0,"delta":message,"finish_reason":finish})
    } else {
        json!({"index":0,"message":message,"finish_reason":finish})
    };
    let response = json!({"id":"chatcmpl_metadata","object":if body["stream"] == true {"chat.completion.chunk"} else {"chat.completion"},"model":"wire-model","choices":[choice],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}});
    if body["stream"] == true {
        Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::from(format!("data: {response}\n\ndata: [DONE]\n\n")))
            .unwrap()
    } else {
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(response.to_string()))
            .unwrap()
    }
}

async fn start_upstream(
    backup: bool,
    captures: Arc<Mutex<Vec<Value>>>,
) -> (
    String,
    std::net::SocketAddr,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .fallback(post(upstream))
                .with_state(Upstream { backup, captures }),
        )
        .with_graceful_shutdown(async {
            let _ = rx.await;
        })
        .await
        .unwrap();
    });
    (format!("http://{addr}/v1"), addr, tx, task)
}

fn manifest(
    port: u16,
    primary: &str,
    backup: &str,
    root: &Path,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let direct = declaration
        .lines()
        .find(|line| line.contains("entry_protocol = \"responses\""))
        .unwrap();
    let relay = r#"  { entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" },"#;
    let declaration = declaration.replace(direct, relay);
    // Deliberately do not use hub_v1_server_execution: it disables refill.
    let mut source = format!(
        r#"
version = 3
{declaration}
[servers.metadata]
bind = "127.0.0.1"
port = {port}
routing_group = "metadata"
endpoints = ["responses"]
[servers.metadata.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
"#
    );
    for (name, base) in [("primary", primary), ("backup", backup)] {
        source.push_str(&format!(r#"
[providers.{name}]
type = "openai_chat"
base_url = "{base}"
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_UNKNOWN_METADATA_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "client" }}
[providers.{name}.models.wire-model]
wire_name = "wire-model"
aliases = ["metadata-client"]
supports_streaming = true
capabilities = ["text", "tools"]
"#));
    }
    source.push_str(r#"
[route_groups.metadata.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "primary", model = "wire-model", key = "controlled", priority = 100 }, { kind = "provider_model", provider = "backup", model = "wire-model", key = "controlled", priority = 1 }]
"#);
    let mut manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    manifest.debug.projection_drop_log_file =
        Some(root.join("projection-drops.jsonl").display().to_string());
    manifest
}

async fn response(
    response: Result<reqwest::Response, reqwest::Error>,
    stream: bool,
) -> Result<Value, String> {
    let response = response.map_err(|e| format!("public request failed: {e:?}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.starts_with(if stream {
        "text/event-stream"
    } else {
        "application/json"
    }) {
        return Err(format!(
            "unexpected content type for stream={stream}: {content_type}"
        ));
    }
    let text = response
        .text()
        .await
        .map_err(|e| format!("public body failed: {e:?}"))?;
    println!("PUBLIC_CLIENT status={status} stream={stream} body={text}");
    if status != StatusCode::OK {
        return Err(format!("public status={status}: {text}"));
    }
    if !stream {
        return serde_json::from_str(&text).map_err(|e| e.to_string());
    }
    parse_sse_response(&text)
}

fn parse_sse_response(text: &str) -> Result<Value, String> {
    let mut events = Vec::new();
    let mut event_name = None;
    let mut data_lines = Vec::new();
    let mut terminal_seen = false;
    for line in text.lines() {
        if line.is_empty() {
            if data_lines.is_empty() {
                event_name = None;
                continue;
            }
            let data = data_lines.join("\n");
            data_lines.clear();
            let event: Value = serde_json::from_str(&data)
                .map_err(|e| format!("malformed SSE JSON: {e}: {data}"))?;
            let payload_type = event["type"]
                .as_str()
                .ok_or_else(|| format!("SSE payload missing type: {event}"))?;
            let name = event_name
                .take()
                .ok_or_else(|| format!("missing SSE event name: {event}"))?;
            if name != payload_type || terminal_seen {
                return Err(format!(
                    "SSE event name/order changed: {name}/{payload_type}"
                ));
            }
            if matches!(payload_type, "error" | "response.failed") {
                return Err(format!("proxy error event: {event}"));
            }
            if payload_type == "response.completed" {
                terminal_seen = true;
            }
            events.push(event);
        } else if !line.starts_with(':') {
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => event_name = Some(value.to_owned()),
                "data" => data_lines.push(value.to_owned()),
                _ => {}
            }
        }
    }
    if event_name.is_some() || !data_lines.is_empty() {
        return Err("SSE ended before a frame dispatch boundary".into());
    }
    let types: Vec<_> = events.iter().filter_map(|e| e["type"].as_str()).collect();
    if types.first() != Some(&"response.created")
        || types.last() != Some(&"response.completed")
        || types.iter().filter(|t| **t == "response.completed").count() != 1
    {
        return Err(format!("invalid SSE order/terminal: {types:?}"));
    }
    if events.last().unwrap()["response"]["output"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["type"] == "function_call"))
    {
        let call = events
            .iter()
            .find(|event| event["type"] == "response.output_item.done")
            .and_then(|event| event.get("item"))
            .filter(|item| {
                item["type"] == "function_call"
                    && item["call_id"] == CALL
                    && item["name"] == "sum"
                    && item["arguments"] == ARGS
            })
            .ok_or_else(|| {
                "SSE did not deliver the completed tool item before terminal".to_owned()
            })?;
        let call_index = events
            .iter()
            .position(|event| {
                event["type"] == "response.output_item.done" && event["item"] == *call
            })
            .unwrap();
        if call_index + 1 >= events.len() || events[call_index + 1]["type"] != "response.completed"
        {
            return Err("tool event was not the final business event before terminal".into());
        }
    }
    Ok(events.last().unwrap()["response"].clone())
}

#[test]
fn sse_gate_rejects_merged_frames_and_no_space_errors() {
    let frame = |name: &str, value: Value| format!("event:{name}\ndata:{value}\n\n");
    let created = frame("response.created", json!({"type":"response.created"}));
    let item = frame(
        "response.output_item.done",
        json!({"type":"response.output_item.done","item":{"type":"function_call",
            "call_id":CALL,"name":"sum","arguments":ARGS}}),
    );
    let completed = frame(
        "response.completed",
        json!({"type":"response.completed","response":{"output":[
            {"type":"function_call","call_id":CALL,"name":"sum","arguments":ARGS}]}}),
    );
    assert!(parse_sse_response(&format!("{created}{item}{completed}")).is_ok());
    assert!(parse_sse_response(&format!(
        "{created}{}{completed}",
        item.trim_end_matches('\n').to_owned() + "\n"
    ))
    .is_err());
    assert!(parse_sse_response(&format!(
        "{created}{}{item}{completed}",
        frame("error", json!({"type":"error"}))
    ))
    .is_err());
}

async fn run(stream: bool, root: &Path) -> Result<(), String> {
    let captures = Arc::new(Mutex::new(Vec::new()));
    let (primary, primary_addr, primary_stop, primary_task) =
        start_upstream(false, captures.clone()).await;
    let (backup, backup_addr, backup_stop, backup_task) =
        start_upstream(true, captures.clone()).await;
    let port = test_ports::free_port();
    let handle = spawn_v3_server_aggregate(manifest(port, &primary, &backup, root))
        .await
        .unwrap();
    let addr = handle.listeners[0].addr;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let port_text = port.to_string();
    let result = async {
        let mut request = json!({"model":"metadata-client","stream":stream,"client_metadata":metadata(),
            "input":[{"role":"user","content":"calculate 19 plus 23"}],
            "tools":[{"type":"function","name":"sum","parameters":{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"],"additionalProperties":false}}]});
        let endpoint = format!("http://{addr}/v1/responses");
        let first = response(client.post(&endpoint).json(&request).send().await,stream).await?;
        let call = first["output"].as_array().and_then(|a| a.iter().find(|i| i["type"] == "function_call")).ok_or_else(|| format!("missing tool call: {first}"))?;
        if call["call_id"] != CALL || call["name"] != "sum" || call["arguments"] != ARGS { return Err(format!("client tool changed: {call}")); }
        let args: Value = serde_json::from_str(call["arguments"].as_str().unwrap()).map_err(|e| e.to_string())?;
        let sum = args["a"].as_i64().ok_or("missing integer a")? + args["b"].as_i64().ok_or("missing integer b")?;
        if sum != 42 { return Err(format!("consumer returned {sum}")); }
        println!("CONSUMER_RECEIPT call_id={CALL} result={sum}");
        request["input"].as_array_mut().unwrap().extend([call.clone(),json!({"type":"function_call_output","call_id":CALL,"output":sum.to_string()})]);
        let followup = response(client.post(&endpoint).json(&request).send().await,stream).await?;
        if first["status"] != "completed" || followup["status"] != "completed" || !followup.to_string().contains("sum accepted 42") || !followup.to_string().contains("refill accepted") { return Err(format!("missing completed business/refill result: {followup}")); }
        let log = std::fs::read_to_string(root.join("projection-drops.jsonl")).map_err(|e| e.to_string())?;
        let records: Vec<Value> = log.lines().map(serde_json::from_str).collect::<Result<_,_>>().map_err(|e| e.to_string())?;
        let metadata_records: Vec<_> = records.iter().filter(|r| r["drop_site"] == "project_openai_client_metadata_to_metadata").collect();
        let mut ids = std::collections::BTreeSet::new();
        for record in &metadata_records {
            let key = match record["json_path"].as_str() { Some("$.client_metadata.unknown") => "unknown",Some("$.client_metadata[\"future.key\"]") => "future.key", _ => return Err(format!("unexpected metadata drop: {record}")) };
            if record["source_value"] != metadata()[key] || record["canonical_value"] != metadata()[key]
                || record["target_protocol"] != "openai_chat" || record["stage"] != "outbound_target_protocol_projection"
                || record["reason"] != "unmapped_target_protocol_field_unrepresentable" || record["entry_port"].as_str() != Some(port_text.as_str())
                || record["ts"].as_u64().unwrap_or(0) == 0 || record["request_id"].as_str().unwrap_or("").is_empty() {
                return Err(format!("incorrect scoped diagnostic: {record}"));
            }
            ids.insert(record["request_id"].as_str().unwrap());
            println!("EXPECTED_PRODUCTION_DROP {record}");
        }
        if ids.len() != 2 { return Err(format!("expected both client request scopes, got {ids:?}")); }
        for id in ids { for path in ["$.client_metadata.unknown","$.client_metadata[\"future.key\"]"] {
            if !metadata_records.iter().any(|r| r["request_id"] == id && r["json_path"] == path) { return Err(format!("missing {id} {path}")); }
        }}
        if records.iter().any(|r| r["json_path"].as_str().is_some_and(|p| p.contains("session_id") || p.contains("x-codex-turn-metadata"))) { return Err("registered local key incorrectly recorded".into()); }
        Ok(())
    }.await;
    // Cleanup precedes assertions, including RED and failed client/body paths.
    handle.shutdown().await;
    let _ = primary_stop.send(());
    let _ = backup_stop.send(());
    primary_task.await.unwrap();
    backup_task.await.unwrap();
    for address in [addr, primary_addr, backup_addr] {
        assert!(
            tokio::net::TcpStream::connect(address).await.is_err(),
            "owned listener still open: {address}"
        );
    }
    println!("OWNED_LISTENERS_RELEASED {addr} {primary_addr} {backup_addr}");
    let captures = captures.lock().unwrap();
    println!(
        "PROVIDER_CAPTURES {}",
        serde_json::to_string(&*captures).unwrap()
    );
    result?;
    let phases: Vec<_> = captures
        .iter()
        .map(|c| c["phase"].as_str().unwrap())
        .collect();
    if phases != ["initial", "followup", "refill"]
        || captures
            .iter()
            .any(|c| c["identity"] != "primary" || !c["error"].is_null())
    {
        return Err(format!("expected primary first-candidate executions initial/followup/refill, no recovery or backup: {captures:?}"));
    }
    Ok(())
}

struct ChildFixture {
    root: std::path::PathBuf,
    child: Option<Child>,
}

impl Drop for ChildFixture {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn fixture_releases_state_after_spawn_failure_and_running_child() {
    let root = std::env::temp_dir().join(format!("rcc-3759f5d-cleanup-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let fixture = ChildFixture {
        root: root.clone(),
        child: None,
    };
    assert!(Command::new(root.join("missing-executable"))
        .spawn()
        .is_err());
    drop(fixture);
    assert!(!root.exists());

    std::fs::create_dir_all(&root).unwrap();
    let child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
    let pid = child.id();
    let fixture = ChildFixture {
        root: root.clone(),
        child: Some(child),
    };
    drop(fixture);
    assert!(!root.exists());
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pid="])
        .output()
        .unwrap();
    assert!(output.stdout.is_empty(), "owned child was not reaped");
}

fn case(name: &str, stream: bool) {
    if std::env::var("V3_UNKNOWN_METADATA_CHILD").as_deref() == Ok(name) {
        let root = std::env::var_os("V3_UNKNOWN_METADATA_ROOT").unwrap();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run(stream, Path::new(&root)));
        assert!(result.is_ok(), "{}", result.unwrap_err());
        return;
    }
    let root = std::env::temp_dir().join(format!("rcc-3759f5d-{name}-{}", std::process::id()));
    let mut fixture = ChildFixture {
        root: root.clone(),
        child: None,
    };
    std::fs::create_dir_all(&root).unwrap();
    let stdout_file = std::fs::File::create(root.join("stdout")).unwrap();
    let stderr_file = std::fs::File::create(root.join("stderr")).unwrap();
    fixture.child = Some(
        Command::new(std::env::current_exe().unwrap())
            .args([name, "--exact", "--nocapture", "--test-threads=1"])
            .env("V3_UNKNOWN_METADATA_CHILD", name)
            .env("V3_UNKNOWN_METADATA_ROOT", &root)
            .env("HOME", &root)
            .env(
                "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
                root.join("request-counter.json"),
            )
            .env("V3_UNKNOWN_METADATA_KEY", "isolated-fixture-key")
            .stdout(Stdio::from(stdout_file))
            .stderr(Stdio::from(stderr_file))
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = fixture.child.as_mut().unwrap().try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "public child timed out");
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = std::fs::read_to_string(root.join("stdout")).unwrap();
    let stderr = std::fs::read_to_string(root.join("stderr")).unwrap();
    print!("{stdout}");
    eprint!("{stderr}");
    drop(fixture);
    assert!(!root.exists(), "owned state not removed");
    assert!(
        status.success(),
        "public child exit={}:\n{stdout}\n{stderr}",
        status
    );
    let printed: Vec<Value> = stderr
        .lines()
        .filter_map(|l| l.strip_prefix("[v3-projection-drop] "))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let expected: Vec<Value> = stdout
        .lines()
        .filter_map(|l| l.strip_prefix("EXPECTED_PRODUCTION_DROP "))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(!expected.is_empty(), "missing persisted evidence");
    for record in expected {
        assert!(
            printed.contains(&record),
            "persisted record missing from production stderr: {record}"
        );
    }
}

#[test]
fn issue3759f5d_unknown_client_metadata_json() {
    case("issue3759f5d_unknown_client_metadata_json", false);
}
#[test]
fn issue3759f5d_unknown_client_metadata_sse() {
    case("issue3759f5d_unknown_client_metadata_sse", true);
}
