//! Provider effort policy: exact directory TOML -> public HTTP -> external wire.
use axum::{extract::State, routing::post, Json, Router};
use routecodex_v3_config::{parse_v3_config_02_authoring, V3ConfigError, V3UserConfigStore};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, fs, net::TcpListener, path::Path, sync::Arc, time::Duration};
use tokio::sync::{oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

struct TestEnvironment {
    previous_home: Option<OsString>,
    previous_counter: Option<OsString>,
    root: tempfile::TempDir,
}

impl TestEnvironment {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let previous_home = std::env::var_os("HOME");
        let previous_counter = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        std::env::set_var("HOME", root.path());
        std::env::set_var(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            root.path().join("counter.json"),
        );
        Self {
            previous_home,
            previous_counter,
            root,
        }
    }
}

impl Drop for TestEnvironment {
    fn drop(&mut self) {
        for (name, previous) in [
            ("HOME", &self.previous_home),
            ("ROUTECODEX_REQUEST_ID_COUNTER_FILE", &self.previous_counter),
        ] {
            if let Some(previous) = previous {
                std::env::set_var(name, previous);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_provider(root: &Path, id: &str, protocol: &str, port: u16, policy: &str) {
    let directory = root.join("provider").join(id);
    fs::create_dir_all(&directory).unwrap();
    let responses = if protocol == "responses" {
        "[provider.responses]\nprocess = \"direct\"\nstreaming = \"client\"\n"
    } else {
        ""
    };
    let compat = if id.contains("compat") {
        "compatibilityProfile = \"chat:deepseek-max\"\n"
    } else {
        ""
    };
    fs::write(
        directory.join("config.v2.toml"),
        format!(
            r#"
version = "2.0.0"
providerId = "{id}"
[provider]
id = "{id}"
type = "{protocol}"
baseURL = "http://127.0.0.1:{port}/v1"
defaultModel = "model"
{compat}
[provider.auth]
type = "apikey"
entries = [{{ alias = "key", apiKey = "fixture-key" }}]
{responses}
[provider.models.model]
wireName = "{id}-wire"
capabilities = ["text", "thinking", "tools"]
supportsThinking = true
thinking = "xhigh"
maxTokens = 4096
maxContextTokens = 128000
[provider.v3]
{policy}
"#
        ),
    )
    .unwrap();
}

fn store(root: &Path, port: u16, providers: &[&str]) -> V3UserConfigStore {
    let targets = providers
        .iter()
        .map(|id| format!("{{ use = \"{id}/model\" }}"))
        .collect::<Vec<_>>()
        .join(", ");
    let path = root.join("config.toml");
    fs::write(
        &path,
        format!(
            r#"
version = 3
[servers.test]
bind = "127.0.0.1"
port = {port}
endpoints = ["responses", "openai_chat"]
[servers.test.routes.default]
tiers = [[{targets}]]
{}"#,
            hub_v1_fixture::hub_v1_server_execution("test")
        ),
    )
    .unwrap();
    let internal = parse_v3_config_02_authoring(&format!(
        "version = 3\n[route_groups.routecodex_v3_4444.pools.default]\ntargets = []\n{}\n[debug]\nlog_console = false\nsnapshots = false\n",
        hub_v1_fixture::hub_v1_test_declaration()
    )).unwrap();
    V3UserConfigStore::with_internal_authoring(path, internal)
}

#[derive(Clone)]
struct Fixture {
    captures: Arc<Mutex<Vec<Value>>>,
    responses: bool,
}

async fn provider(State(state): State<Fixture>, Json(body): Json<Value>) -> Json<Value> {
    state.captures.lock().await.push(body.clone());
    if state.responses {
        Json(
            json!({"id":"resp_policy","object":"response","status":"completed",
            "model":body["model"],"output":[{"type":"message","id":"msg_policy",
            "role":"assistant","status":"completed","content":[{"type":"output_text",
            "text":"policy fixture ok","annotations":[]}]}],
            "usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}),
        )
    } else {
        Json(
            json!({"id":"chatcmpl-policy","object":"chat.completion","created":0,
            "model":body["model"],"choices":[{"index":0,"message":{"role":"assistant",
            "content":"policy fixture ok"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}),
        )
    }
}

fn request(responses: bool, id: &str, effort: Option<&str>) -> Value {
    let mut body = if responses {
        json!({"model":format!("{id}.model"),"stream":false,"temperature":0.25,
            "input":[{"role":"user","content":"preserve this content"}]})
    } else {
        json!({"model":format!("{id}.model"),"stream":false,"temperature":0.25,
            "messages":[{"role":"user","content":"preserve this content"}]})
    };
    if let Some(effort) = effort {
        if responses {
            body["reasoning"] = json!({"effort":effort,"summary":"auto"});
        } else {
            body["reasoning_effort"] = json!(effort);
        }
    }
    body
}

#[tokio::test]
async fn provider_reasoning_effort_policy_direct_relay_public_http() {
    let _lock = TEST_LOCK.lock().await;
    let environment = TestEnvironment::new();
    let captures = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture_addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(provider).with_state(Fixture {
                captures: captures.clone(),
                responses: false,
            }),
        )
        .route(
            "/v1/responses",
            post(provider).with_state(Fixture {
                captures: captures.clone(),
                responses: true,
            }),
        );
    let fixture_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    let ids = [
        "chatmedium",
        "chatlow",
        "chatplain",
        "respmedium",
        "resplow",
        "respplain",
        "chathigh",
        "chatxhigh",
        "resphigh",
        "respxhigh",
        "chatcompatmedium",
        "respcompatmedium",
    ];
    for id in ids {
        let protocol = if id.starts_with("resp") {
            "responses"
        } else {
            "openai_chat"
        };
        let policy = if id.ends_with("medium") {
            "reasoning_effort = \"medium\""
        } else if id.ends_with("low") {
            "reasoning_effort = \"low\""
        } else if id.ends_with("xhigh") {
            "reasoning_effort = \"xhigh\""
        } else if id.ends_with("high") {
            "reasoning_effort = \"high\""
        } else {
            ""
        };
        write_provider(
            environment.root.path(),
            id,
            protocol,
            fixture_addr.port(),
            policy,
        );
    }
    let server_port = free_port();
    let manifest = store(environment.root.path(), server_port, &ids)
        .load_manifest()
        .unwrap();
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let mut failure = None;
    // Cross-protocol entries select Relay; same-protocol entries select Direct.
    // Keep both configured and unconfigured providers in this single manifest.
    'cases: for responses_entry in [false, true] {
        let endpoint = if responses_entry {
            "/v1/responses"
        } else {
            "/v1/chat/completions"
        };
        for id in ids {
            for client_effort in [Some("xhigh"), None] {
                let response = client
                    .post(format!("http://127.0.0.1:{server_port}{endpoint}"))
                    .json(&request(responses_entry, id, client_effort))
                    .send()
                    .await;
                let result = match response {
                    Ok(response) if response.status().is_success() => {
                        response.text().await.map_err(|e| e.to_string())
                    }
                    Ok(response) => Err(format!("unexpected client status {}", response.status())),
                    Err(error) => Err(error.to_string()),
                };
                let captured = captures.lock().await.pop();
                let expected = if id.ends_with("medium") {
                    Some("medium")
                } else if id.ends_with("low") {
                    Some("low")
                } else if id.ends_with("xhigh") {
                    Some("xhigh")
                } else if id.ends_with("high") {
                    Some("high")
                } else {
                    client_effort
                };
                let check = result.and_then(|body| {
                    if !body.contains("policy fixture ok") || body.contains("\"error\"") {
                        return Err(format!("client body {body}"));
                    }
                    let wire = captured.ok_or("provider received no request")?;
                    let path = if id.starts_with("resp") { "/reasoning/effort" } else { "/reasoning_effort" };
                    if wire.pointer(path).and_then(Value::as_str) != expected {
                        return Err(format!("{id} {endpoint} client={client_effort:?} expected={expected:?} wire={wire}"));
                    }
                    if wire["model"] != format!("{id}-wire") || wire["temperature"] != 0.25
                        || !wire.to_string().contains("preserve this content") {
                        return Err(format!("adjacent fields changed: {wire}"));
                    }
                    if client_effort.is_some() && responses_entry && id.starts_with("resp") && wire["reasoning"]["summary"] != "auto" {
                        return Err(format!("reasoning sibling changed: {wire}"));
                    }
                    println!("PASS {endpoint} -> {id}: client={client_effort:?} final={expected:?}");
                    Ok(())
                });
                if let Err(error) = check {
                    failure = Some(error);
                    break 'cases;
                }
            }
        }
    }
    handle.shutdown().await;
    shutdown_tx.send(()).unwrap();
    fixture_task.await.unwrap();
    assert!(
        tokio::net::TcpStream::connect(fixture_addr).await.is_err(),
        "fixture listener leaked"
    );
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", server_port))
            .await
            .is_err(),
        "server listener leaked"
    );
    assert!(captures.lock().await.is_empty(), "extra provider attempts");
    assert!(failure.is_none(), "{}", failure.unwrap_or_default());
}

#[tokio::test]
async fn provider_reasoning_effort_policy_config_failures() {
    let _lock = TEST_LOCK.lock().await;
    let environment = TestEnvironment::new();
    for (protocol, policy, parse_failure) in [
        ("openai_chat", "reasoning_effort = \"invalid\"", true),
        ("anthropic", "reasoning_effort = \"medium\"", false),
        ("gemini", "reasoning_effort = \"low\"", false),
    ] {
        write_provider(environment.root.path(), "policy", protocol, 9, policy);
        let result = store(environment.root.path(), free_port(), &["policy"]).load_manifest();
        if parse_failure {
            assert!(matches!(result, Err(V3ConfigError::Parse(_))), "{result:?}");
        } else {
            assert!(
                matches!(result, Err(V3ConfigError::Validation(ref reason)) if reason.contains("reasoning_effort")),
                "{result:?}"
            );
        }
    }
}
