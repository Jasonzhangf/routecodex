//! Public Responses entry, validating external Chat peer, real client execution.
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{parse_v3_config_02_authoring, V3UserConfigStore};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::Path,
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
static TEST_LOCK: Mutex<()> = Mutex::const_new(());
const MARKER: &str = "ZEN_REAL_CLIENT_MARKER";
const IMAGE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const GRAMMAR: &str = r#"start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/"#;

fn declarations() -> Value {
    json!({"type":"additional_tools","role":"developer","tools":[
        {"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","description":"Run JavaScript code to orchestrate/compose tool calls. Evaluates the provided JavaScript code in a fresh V8 isolate as an async module. Nested tools are available on tools, including await tools.exec_command(...). Runs raw JavaScript. text(value) emits actual tool receipts.","format":{"type":"grammar","syntax":"lark","definition":GRAMMAR}},
            {"type":"function","name":"wait","parameters":{"type":"object","properties":{"cell_id":{"type":"string"}},"required":["cell_id"]}},
            {"type":"function","name":"request_user_input","parameters":{"type":"object","properties":{"questions":{"type":"array"}}}}
        ]},
        {"type":"namespace","name":"mcp__cua_repl","tools":[
            {"type":"function","name":"js","parameters":{"type":"object","properties":{"code":{"type":"string"}}}},
            {"type":"function","name":"js_reset","parameters":{"type":"object","properties":{}}}
        ]}
    ]})
}

#[derive(Clone)]
struct Peer {
    captures: Arc<Mutex<Vec<Value>>>,
    errors: Arc<Mutex<Vec<String>>>,
    native: &'static str,
    arguments: String,
    correction: bool,
    guarded: bool,
    image: bool,
}

fn check_wire(body: &Value, peer: &Peer, stage: usize) -> Result<(), String> {
    if peer.image {
        let messages = body["messages"].as_array().ok_or("messages missing")?;
        let images: Vec<_> = messages
            .iter()
            .flat_map(|message| message["content"].as_array().into_iter().flatten())
            .filter(|part| part["type"] == "image_url")
            .map(|part| part["image_url"]["url"].as_str())
            .collect();
        if images != vec![Some(IMAGE)] {
            return Err(format!(
                "latest view_image bytes lost or historical image restored: {images:?}"
            ));
        }
        let calls: Vec<_> = messages
            .iter()
            .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
            .filter(|call| call["id"] == "call_image")
            .collect();
        if calls.len() != 1 || calls[0]["function"]["name"] != "view_image" {
            return Err("view_image identity lost".into());
        }
        if messages
            .iter()
            .filter(|message| message["role"] == "tool" && message["tool_call_id"] == "call_image")
            .count()
            != 1
        {
            return Err("view_image result pairing lost".into());
        }
    }
    let tools = body["tools"].as_array().ok_or("tools missing")?;
    let names: Vec<_> = tools
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    if peer.guarded {
        if names.iter().any(|name| matches!(*name, "bash" | "read")) {
            return Err("unbound executor gained aliases".into());
        }
        return Ok(());
    }
    for name in [
        "functions__exec",
        "functions__wait",
        "functions__request_user_input",
        "mcp__cua_repl__js",
        "mcp__cua_repl__js_reset",
        "bash",
        "read",
    ] {
        if !names.contains(&name) {
            return Err(format!("missing declared tool {name}: {names:?}"));
        }
    }
    if tools.len() != 7 {
        return Err(format!("tool inventory changed: {}", tools.len()));
    }
    if stage == 0 {
        return Ok(());
    }
    let messages = body["messages"].as_array().ok_or("messages missing")?;
    for prior in 0..stage {
        let id = format!("call_{}", prior + 1);
        let expected = if peer.correction && prior == 0 {
            "{\"command\":42,\"unknown\":true}"
        } else {
            &peer.arguments
        };
        let calls: Vec<_> = messages
            .iter()
            .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
            .filter(|call| call["id"] == id)
            .collect();
        if calls.len() != 1
            || calls[0]["function"]["name"] != peer.native
            || calls[0]["function"]["arguments"] != expected
        {
            return Err(format!("native history mismatch for {id}: {calls:?}"));
        }
        let results: Vec<_> = messages
            .iter()
            .filter(|message| message["role"] == "tool" && message["tool_call_id"] == id)
            .collect();
        if results.len() != 1 {
            return Err(format!("result pairing mismatch for {id}: {results:?}"));
        }
        let receipt: Value = serde_json::from_str(
            results[0]["content"]
                .as_str()
                .ok_or("receipt content missing")?,
        )
        .map_err(|error| error.to_string())?;
        if peer.correction && prior == 0 {
            if !receipt["client_error"]
                .as_str()
                .is_some_and(|error| error.contains("42") && error.contains("unknown"))
            {
                return Err(format!("not an actual argument error: {receipt}"));
            }
        } else if receipt["exit_code"] != 0
            || !receipt["output"]
                .as_str()
                .is_some_and(|output| output.contains(MARKER))
        {
            return Err(format!("not an actual execution receipt: {receipt}"));
        }
    }
    Ok(())
}

async fn provider(State(peer): State<Peer>, Json(body): Json<Value>) -> Response {
    let mut captures = peer.captures.lock().await;
    let stage = captures.len();
    captures.push(body.clone());
    drop(captures);
    if let Err(error) = check_wire(&body, &peer, stage) {
        eprintln!("validating peer rejected stage={stage}: {error}");
        peer.errors.lock().await.push(error.clone());
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":{"message":error,"type":"FreeTierError"}})),
        )
            .into_response();
    }
    let terminal = peer.guarded || stage >= if peer.correction { 2 } else { 1 };
    let args = if peer.correction && stage == 0 {
        "{\"command\":42,\"unknown\":true}"
    } else {
        &peer.arguments
    };
    let message = if terminal {
        json!({"role":"assistant","content":MARKER})
    } else {
        json!({"role":"assistant","content":null,"tool_calls":[{"id":format!("call_{}",stage+1),"type":"function","function":{"name":peer.native,"arguments":args}}]})
    };
    let finish = if terminal { "stop" } else { "tool_calls" };
    if body["stream"] == true {
        let mut delta = message;
        if let Some(calls) = delta.get_mut("tool_calls").and_then(Value::as_array_mut) {
            for (index, call) in calls.iter_mut().enumerate() {
                call["index"] = json!(index);
            }
        }
        let first = json!({"id":"chatcmpl-peer","object":"chat.completion.chunk","created":0,"model":body["model"],"choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let last = json!({"id":"chatcmpl-peer","object":"chat.completion.chunk","created":0,"model":body["model"],"choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}});
        (
            [("content-type", "text/event-stream")],
            format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    } else {
        Json(json!({"id":"chatcmpl-peer","object":"chat.completion","created":0,"model":body["model"],"choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})).into_response()
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn store(root: &Path, server_port: u16, provider_port: u16) -> V3UserConfigStore {
    let directory = root.join("provider/zenpeer");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("config.v2.toml"),
        format!(
            r#"
version = "2.0.0"
providerId = "zenpeer"
[provider]
id = "zenpeer"
type = "openai_chat"
baseURL = "http://127.0.0.1:{provider_port}/v1"
defaultModel = "model"
compatibilityProfile = "chat:opencode-zen-tcm"
[provider.auth]
type = "apikey"
entries = [{{alias="key",apiKey="test-only-key"}}]
[provider.models.model]
wireName = "peer-model"
capabilities = ["text","tools"]
maxTokens = 4096
maxContextTokens = 128000
"#
        ),
    )
    .unwrap();
    let path = root.join("config.toml");
    fs::write(
        &path,
        format!(
            r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = {server_port}
endpoints = ["responses"]
[servers.test.routes.default]
tiers = [[{{use="zenpeer/model"}}]]
{}
"#,
            hub_v1_fixture::hub_v1_server_execution("test")
        ),
    )
    .unwrap();
    let internal = parse_v3_config_02_authoring(&format!("version = 3\n[route_groups.routecodex_v3_4444.pools.default]\ntargets=[]\n{}\n[debug]\nlog_console=false\nsnapshots=false\n",hub_v1_fixture::hub_v1_test_declaration())).unwrap();
    V3UserConfigStore::with_internal_authoring(path, internal)
}

/// A real consumer of the declared async JS executor contract. It executes the
/// returned input, rather than supplying a prewritten stdout/success fixture.
fn execute_client(source: &str, cwd: &Path) -> Value {
    let executor = r#"
import {spawnSync} from 'node:child_process';
let source=''; for await (const chunk of process.stdin) source+=chunk;
let emitted;
const tools={exec_command:async ({cmd})=>{
  const result=spawnSync('/bin/sh',['-c',cmd],{encoding:'utf8'});
  if(result.error) throw result.error;
  return {exit_code:result.status,output:result.stdout+result.stderr,stderr:result.stderr};
}};
try {
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('tools','text',source)(tools,value=>{emitted=value;});
  process.stdout.write(JSON.stringify(emitted));
} catch(error) { process.stdout.write(JSON.stringify({client_error:String(error)})); }
"#;
    let mut child = Command::new("node")
        .args(["--input-type=module", "--eval", executor])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(source.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "client executor failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

async fn send(
    client: &reqwest::Client,
    port: u16,
    body: &Value,
    errors: &Arc<Mutex<Vec<String>>>,
) -> Value {
    let reply = client
        .post(format!("http://127.0.0.1:{port}/v1/responses"))
        .json(body)
        .send()
        .await;
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => panic!(
            "public request failed: {error}; peer errors: {:?}",
            errors.lock().await
        ),
    };
    assert!(reply.status().is_success());
    let raw = reply.text().await.unwrap_or_else(|error| {
        panic!(
            "public body failed: {error}; peer errors: {:?}",
            errors.try_lock()
        )
    });
    if body["stream"] == true {
        raw.lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .find(|event| event["type"] == "response.completed")
            .unwrap_or_else(|| {
                panic!(
                    "missing completed event: {raw}; peer errors: {:?}",
                    errors.try_lock()
                )
            })
            .get("response")
            .unwrap()
            .clone()
    } else {
        serde_json::from_str(&raw).unwrap()
    }
}

async fn roundtrip(native: &'static str, stream: bool, correction: bool, guarded: bool) {
    roundtrip_with_image(native, stream, correction, guarded, false).await;
}

async fn roundtrip_with_image(
    native: &'static str,
    stream: bool,
    correction: bool,
    guarded: bool,
    image: bool,
) {
    let _lock = TEST_LOCK.lock().await;
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("literal '$`雪\n.txt");
    fs::write(&file, format!("{MARKER}\n")).unwrap();
    let written = format!("{MARKER}\n{}", "雪 '$` <svg>完整内容</svg>\n".repeat(256));
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let command = format!(
        "printf '%s' {} > {}; cat -- {}",
        quote(&written),
        quote(file.to_str().unwrap()),
        quote(file.to_str().unwrap())
    );
    let arguments = if native == "read" {
        json!({"filePath":file.to_str().unwrap()}).to_string()
    } else if native == "functions__exec" {
        json!({"input":format!("text(await tools.exec_command({}));",json!({"cmd":command}))})
            .to_string()
    } else if native == "exec_command" {
        json!({"cmd":command}).to_string()
    } else {
        json!({"command":format!("printf '%s\\n' '{MARKER}'")}).to_string()
    };
    let peer = Peer {
        captures: Arc::new(Mutex::new(Vec::new())),
        errors: Arc::new(Mutex::new(Vec::new())),
        native,
        arguments,
        correction,
        guarded,
        image,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_port = listener.local_addr().unwrap().port();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(provider).with_state(peer.clone()),
    );
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let port = free_port();
    let manifest = store(root.path(), port, provider_port)
        .load_manifest()
        .unwrap();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let mut decl = declarations();
    if guarded {
        decl["tools"][0]["tools"][0]["format"]["definition"] = json!("start: 'restricted'");
    }
    let mut body = json!({"model":"zenpeer.model","stream":stream,"tool_choice":"auto","input":[decl,{"role":"user","content":"execute the declared safe fixture operation"}]});
    if image {
        body["model"] = json!("image-route-alias");
        let input = body["input"].as_array_mut().unwrap();
        input.push(json!({"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,OLD_HISTORY"}]}));
        input.push(json!({"type":"function_call","name":"view_image","call_id":"call_image","arguments":"{\"path\":\"/actual-client-image.png\"}"}));
        input.push(json!({"type":"function_call_output","call_id":"call_image","output":[{"type":"input_image","image_url":IMAGE}]}));
        input.push(
            json!({"role":"user","content":"Current time reminder; preserve latest tool image"}),
        );
    }
    for turn in 0..4 {
        let response = send(&client, port, &body, &peer.errors).await;
        let output = response["output"].as_array().unwrap();
        let calls: Vec<_> = output
            .iter()
            .filter(|item| item["type"] == "custom_tool_call" || item["type"] == "function_call")
            .collect();
        if calls.is_empty() {
            assert!(
                response["output_text"] == MARKER
                    || output.iter().any(|item| item["content"]
                        .as_array()
                        .is_some_and(|parts| parts.iter().any(|part| part["text"] == MARKER))),
                "no verified marker: {response}"
            );
            assert_eq!(
                peer.captures.lock().await.len(),
                if guarded {
                    1
                } else if correction {
                    3
                } else {
                    2
                },
                "provider retry masked shape failure"
            );
            assert!(peer.errors.lock().await.is_empty());
            if matches!(native, "functions__exec" | "exec_command") {
                assert_eq!(fs::read_to_string(&file).unwrap(), written);
            }
            handle.shutdown().await;
            let _ = shutdown_tx.send(());
            task.await.unwrap();
            return;
        }
        assert_eq!(calls.len(), 1);
        let call = calls[0];
        let source = if native == "exec_command" {
            assert_eq!(call["type"], "function_call");
            assert_eq!(call["name"], "exec_command");
            assert_eq!(call["arguments"], peer.arguments);
            format!(
                "text(await tools.exec_command({}));",
                call["arguments"].as_str().unwrap()
            )
        } else {
            assert_eq!(call["type"], "custom_tool_call");
            assert_eq!(call["namespace"], "functions");
            assert_eq!(call["name"], "exec");
            if native == "functions__exec" {
                assert_eq!(
                    call["input"],
                    serde_json::from_str::<Value>(&peer.arguments).unwrap()["input"]
                );
            }
            call["input"].as_str().unwrap().to_owned()
        };
        let receipt = execute_client(&source, root.path());
        println!(
            "turn={turn} stream={stream} native={native} call={} actual_receipt={receipt}",
            call["call_id"]
        );
        let input = body["input"].as_array_mut().unwrap();
        input.extend(output.iter().cloned());
        let result_type = if call["type"] == "function_call" {
            "function_call_output"
        } else {
            "custom_tool_call_output"
        };
        input.push(
            json!({"type":result_type,"call_id":call["call_id"],"output":receipt.to_string()}),
        );
    }
    panic!("no completed tool follow-up");
}

#[tokio::test]
async fn zen_tcm_bash_native_history_roundtrip() {
    roundtrip("bash", false, false, false).await;
}
#[tokio::test]
async fn zen_tcm_read_native_history_roundtrip() {
    roundtrip("read", true, false, false).await;
}
#[tokio::test]
async fn zen_tcm_invalid_args_native_history_correction() {
    roundtrip("bash", false, true, false).await;
}
#[tokio::test]
async fn zen_tcm_incompatible_executor_preserved() {
    roundtrip("bash", false, false, true).await;
}
#[tokio::test]
async fn zen_tcm_original_executor_file_write_history_roundtrip() {
    roundtrip("functions__exec", true, false, false).await;
}
#[tokio::test]
async fn zen_tcm_direct_shell_file_write_history_roundtrip() {
    roundtrip("exec_command", true, false, false).await;
}

#[tokio::test]
async fn zen_tcm_latest_view_image_and_read_followup_preserve_bytes_and_pairing() {
    roundtrip_with_image("read", true, false, false, true).await;
}
