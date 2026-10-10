use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    net::TcpListener,
    sync::{atomic::AtomicUsize, Arc},
    time::Duration,
};
use tokio::sync::{mpsc, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone)]
struct RecoveryPeer {
    business: Arc<AtomicUsize>,
    probe_body: Arc<Mutex<String>>,
    receipts: mpsc::UnboundedSender<Value>,
}

async fn recovery_peer(
    State(peer): State<RecoveryPeer>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(headers.get("authorization").unwrap(), "Bearer pool-key-01");
    assert_eq!(body["model"], "wire-pool-model");
    if body.pointer("/messages/0/content") == Some(&json!("Reply exactly OK. Do not call tools.")) {
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning_effort"], "low");
        assert!(body.get("max_tokens").is_none());
        let names: Vec<_> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["bash", "read"]);
        peer.receipts.send(body).unwrap();
        return (
            [("content-type", "text/event-stream")],
            peer.probe_body.lock().await.clone(),
        )
            .into_response();
    }
    let attempt = peer
        .business
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    if attempt < 3 {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":{"type":"rate_limit_error","message":"rate limit"}})),
        )
            .into_response();
    }
    success_response(Mode::Relay, body["stream"] == true)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn zen_429_three_failures_and_http_2xx_streaming_recovery_public() {
    let _guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let probe_body = Arc::new(Mutex::new("data: [DONE]\n\n".to_string()));
    let business = Arc::new(AtomicUsize::new(0));
    let peer = RecoveryPeer {
        business: business.clone(),
        probe_body: probe_body.clone(),
        receipts: tx,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer_task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(recovery_peer))
                .with_state(peer),
        )
        .await
        .unwrap();
    });
    let mut config = manifest(free_port(), port, 11, Mode::Relay);
    config
        .providers
        .get_mut("poolpeer")
        .unwrap()
        .auth
        .entries
        .truncate(1);
    for pool in config
        .route_groups
        .get_mut("default")
        .unwrap()
        .pools
        .values_mut()
    {
        pool.targets.truncate(1);
    }
    let server = spawn_v3_server_aggregate(config).await.unwrap();
    let base = format!("http://{}", server.listeners[0].addr);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    for number in 1..=3 {
        let reply = client
            .post(format!("{base}/v1/responses"))
            .json(&request(false))
            .send()
            .await;
        if let Ok(reply) = reply {
            assert!(!reply.status().is_success());
            let _ = reply.bytes().await;
        }
        let pool: Value = client
            .get(format!("{base}/_routecodex/health/cooldown-pool"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if number < 3 {
            assert_eq!(pool["entries"], json!([]), "429 {number} must not cool");
        } else {
            assert!(pool["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["provider_id"] == "poolpeer"
                    && entry["auth_alias"] == "pool-key-01"
                    && entry["model_id"] == "model"));
        }
    }
    assert_eq!(business.load(std::sync::atomic::Ordering::SeqCst), 3);
    // Recovery is scheduled automatically after the third business 429.
    // A nonterminal 2xx SSE response is sufficient, regardless of its body.
    tokio::time::timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let pool: Value = client
                .get(format!("{base}/_routecodex/health/cooldown-pool"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if pool["entries"] == json!([]) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("HTTP 2xx probe must restore identity");
    let reply = client
        .post(format!("{base}/v1/responses"))
        .json(&request(false))
        .send()
        .await
        .unwrap();
    assert!(
        reply.status().is_success(),
        "restored account must serve business request"
    );
    assert_eq!(reply.json::<Value>().await.unwrap()["status"], "completed");
    assert_eq!(business.load(std::sync::atomic::Ordering::SeqCst), 4);
    server.shutdown().await;
    peer_task.abort();
}

const ACCOUNTS: [&str; 11] = [
    "pool-key-01",
    "pool-key-02",
    "pool-key-03",
    "pool-key-04",
    "pool-key-05",
    "pool-key-06",
    "pool-key-07",
    "pool-key-08",
    "pool-key-09",
    "pool-key-10",
    "pool-key-11",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct SendReceipt {
    index: usize,
    identity: String,
    authorization: String,
    model: String,
    body: Value,
    valid_payload: bool,
}

#[derive(Clone)]
struct Peer {
    receipts: mpsc::UnboundedSender<SendReceipt>,
    scenario: Scenario,
    send_count: Arc<AtomicUsize>,
    mode: Mode,
}

#[derive(Clone, Copy)]
enum Scenario {
    FirstTenFail,
    AllFail,
    BudgetEightFail,
}

struct CounterEnvironment {
    previous: Option<OsString>,
    _directory: tempfile::TempDir,
}

impl CounterEnvironment {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
        std::env::set_var(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            directory.path().join("request-id-counter.json"),
        );
        Self {
            previous,
            _directory: directory,
        }
    }
}

impl Drop for CounterEnvironment {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE", previous);
        } else {
            std::env::remove_var("ROUTECODEX_REQUEST_ID_COUNTER_FILE");
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

fn auth_entries() -> String {
    ACCOUNTS
        .iter()
        .map(|account| format!("{{ alias = \"{account}\", apiKey = \"{account}\" }}"))
        .collect::<Vec<_>>()
        .join(",\n  ")
}

fn pool_targets() -> String {
    ACCOUNTS
        .iter()
        .enumerate()
        .map(|(index, account)| {
            format!(
                "  {{ kind = \"provider_model\", provider = \"poolpeer\", model = \"model\", key = \"{account}\", priority = {} }}",
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join(",\n")
}

fn declarations() -> Value {
    let grammar = r#"start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/"#;
    json!({"type":"additional_tools","role":"developer","tools":[
        {"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","description":"Evaluates JavaScript in a fresh V8 isolate as an async module. tools.exec_command. Runs raw JavaScript. text(value)","format":{"type":"grammar","syntax":"lark","definition":grammar}},
            {"type":"function","name":"wait","parameters":{"type":"object","properties":{"cell_id":{"type":"string"}},"required":["cell_id"]}},
            {"type":"function","name":"request_user_input","parameters":{"type":"object","properties":{"questions":{"type":"array"}}}}
        ]},
        {"type":"namespace","name":"mcp__cua_repl","tools":[
            {"type":"function","name":"js","parameters":{"type":"object","properties":{"code":{"type":"string"}}}},
            {"type":"function","name":"js_reset","parameters":{"type":"object","properties":{}}}
        ]}
    ]})
}

fn required_native_tools() -> Vec<&'static str> {
    vec![
        "functions__exec",
        "functions__wait",
        "functions__request_user_input",
        "mcp__cua_repl__js",
        "mcp__cua_repl__js_reset",
        "bash",
        "read",
    ]
}

fn validate_payload(body: &Value, stream: bool, mode: Mode) -> Result<(), String> {
    if body.get("model") != Some(&json!("wire-pool-model")) {
        return Err(format!("invalid model: {}", body["model"]));
    }
    if body.get("stream") != Some(&json!(stream)) {
        return Err(format!("invalid stream: {}", body["stream"]));
    }
    if mode == Mode::Direct {
        return if body["input"] == request(stream)["input"] {
            Ok(())
        } else {
            Err("Direct changed original TCM input/tool declarations".to_string())
        };
    }
    if body.pointer("/messages/0/role") != Some(&json!("user")) {
        return Err("missing user message".to_string());
    }
    if body.pointer("/messages/0/content")
        != Some(&json!("exercise independent provider account pool"))
    {
        return Err("invalid user payload".to_string());
    }
    let tools = body["tools"].as_array().ok_or("tools missing")?;
    if tools.len() != 7 {
        return Err(format!("tool inventory changed: {}", tools.len()));
    }
    let names = tools
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect::<Vec<_>>();
    for name in required_native_tools() {
        if !names.contains(&name) {
            return Err(format!("missing declared tool {name}: {names:?}"));
        }
    }
    if !tools.iter().any(|tool| {
        tool["function"]["name"] == "functions__exec" && tool["function"]["parameters"].is_object()
    }) {
        return Err("functions__exec parameters lost".to_string());
    }
    Ok(())
}

fn peer_route(mode: Mode) -> &'static str {
    match mode {
        Mode::Direct => "/v1/responses",
        Mode::Relay => "/v1/chat/completions",
    }
}

fn success_response(mode: Mode, stream: bool) -> Response {
    if mode == Mode::Relay {
        let message = json!({"role":"assistant","content":"pool success"});
        if stream {
            let chunk = json!({"id":"chatcmpl-peer","object":"chat.completion.chunk","created":0,"model":"wire-pool-model","choices":[{"index":0,"delta":message,"finish_reason":null}]});
            let last = json!({"id":"chatcmpl-peer","object":"chat.completion.chunk","created":0,"model":"wire-pool-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}});
            return (
                [("content-type", "text/event-stream")],
                format!("data: {chunk}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
            )
                .into_response();
        }
        return Json(json!({"id":"chatcmpl-peer","object":"chat.completion","created":0,"model":"poolpeer.model","choices":[{"index":0,"message":message,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})).into_response();
    }

    let response = json!({"id":"resp-peer","object":"response","created_at":0,"model":"wire-pool-model","status":"completed","output":[{"type":"message","id":"msg-peer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"pool success","annotations":[]}]}],"error":null,"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}});
    if stream {
        let event = json!({"type":"response.completed","sequence_number":0,"response":response});
        (
            [("content-type", "text/event-stream")],
            format!("event: response.completed\ndata: {event}\n\n"),
        )
            .into_response()
    } else {
        Json(response).into_response()
    }
}

fn bearer(account: &str) -> String {
    format!("Bearer {account}")
}

async fn peer_provider(
    State(peer): State<Peer>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let account = ACCOUNTS
        .iter()
        .find(|account| authorization == bearer(account))
        .copied()
        .unwrap_or("invalid")
        .to_string();
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let expected_probe = match peer.mode {
        Mode::Direct => {
            json!({"model":"wire-pool-model","input":[{"role":"user","content":[{"type":"input_text","text":"ping; reply pong"}]}],"stream":false})
        }
        Mode::Relay => {
            json!({"model":"wire-pool-model","messages":[{"role":"user","content":"ping; reply pong"}],"max_tokens":1,"stream":false})
        }
    };
    if body == expected_probe && account != "invalid" {
        // Recovery traffic has its own registered shape and does not count as
        // a business send. Fail it honestly so it cannot revive a failed key.
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}))).into_response();
    }
    if peer.mode == Mode::Relay
        && body.pointer("/messages/0/content")
            == Some(&json!("Reply exactly OK. Do not call tools."))
    {
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["tools"].as_array().unwrap().len(), 2);
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(
                json!({"error":{"type":"rate_limit_error","message":"probe remains unavailable"}}),
            ),
        )
            .into_response();
    }
    let index = peer
        .send_count
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let error = validate_payload(&body, stream, peer.mode)
        .err()
        .unwrap_or_default();
    let valid_payload = error.is_empty() && account != "invalid";
    eprintln!("pool peer send={index} account={account} valid={valid_payload} error={error}");
    peer.receipts
        .send(SendReceipt {
            index,
            identity: format!("poolpeer:model:{account}"),
            authorization: authorization.clone(),
            model: body["model"].as_str().unwrap_or_default().to_string(),
            body: body.clone(),
            valid_payload,
        })
        .expect("receipt channel must remain open");
    let should_fail = match peer.scenario {
        Scenario::FirstTenFail => index <= 10,
        Scenario::AllFail => true,
        Scenario::BudgetEightFail => true,
    };
    if !valid_payload {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":{"type":"peer_validation_error","message":error}})),
        )
            .into_response();
    }
    if should_fail {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}})),
        )
            .into_response();
    }
    success_response(peer.mode, stream)
}

fn manifest(
    server_port: u16,
    peer_port: u16,
    request_max_attempts: u16,
    mode: Mode,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let execution = hub_v1_fixture::hub_v1_server_execution("test");
    let (declaration, provider_block) = match mode {
        Mode::Direct => (
            hub_v1_fixture::hub_v1_test_declaration(),
            r#"type = "responses"
base_url = "http://127.0.0.1:{peer_port}/v1"
default_model = "model""#,
        ),
        Mode::Relay => {
            let direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
            let relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
            (
                hub_v1_fixture::hub_v1_test_declaration().replace(direct, relay),
                r#"type = "openai_chat"
compatibilityProfile = "chat:opencode-zen-tcm"
base_url = "http://127.0.0.1:{peer_port}/v1"
default_model = "model"
responses = {{ process = "chat", streaming = "client" }}"#,
            )
        }
    };
    let provider_block = provider_block
        .replace("{peer_port}", &peer_port.to_string())
        .replace("{{", "{")
        .replace("}}", "}");
    let source = format!(
        r#"
version = 3

{declaration}

[debug]
log_console = false
snapshots = false
dry_run = false

[servers.test]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]

{execution}
attempt_store = {{ request_max_attempts = {request_max_attempts}, attempt_max_bytes = 67108864, attempt_max_frames = 262144, request_max_bytes = 67108864, process_max_bytes = 536870912, residence_timeout_ms = 600000 }}

[providers.poolpeer]
{provider_block}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 5000 }}
auth = {{ type = "api_key", entries = [
  {auth_entries}
] }}

[providers.poolpeer.models.model]
wire_name = "wire-pool-model"
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
{pool_targets}
]

[error.policies.target_pool_exhausted]
action = "terminate_transport"

[error.policies.local_resource_exhausted]
action = "terminate_transport"
"#,
        declaration = declaration,
        auth_entries = auth_entries(),
        pool_targets = pool_targets(),
        provider_block = provider_block,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn request(stream: bool) -> Value {
    let mut input = Vec::new();
    input.push(declarations());
    input.push(json!({"role":"user","content":"exercise independent provider account pool"}));
    json!({"model":"poolpeer.model","stream":stream,"input":input})
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Direct,
    Relay,
}

async fn run_json_sse_success(scenario: Scenario, mode: Mode) {
    let _test_guard = TEST_LOCK.lock().await;
    for stream in [false, true] {
        let _counter = CounterEnvironment::new();
        let (receipts_tx, mut receipts_rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let peer_port = listener.local_addr().unwrap().port();
        let app = Router::new()
            .route(peer_route(mode), post(peer_provider))
            .with_state(Peer {
                receipts: receipts_tx.clone(),
                scenario,
                send_count: Arc::new(AtomicUsize::new(0)),
                mode,
            });
        let peer_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let server = spawn_v3_server_aggregate(manifest(free_port(), peer_port, 11, mode))
            .await
            .unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap();
        let endpoint = format!("http://{}/v1/responses", server.listeners[0].addr);

        let reply = client
            .post(&endpoint)
            .json(&request(stream))
            .send()
            .await
            .unwrap_or_else(|error| {
                let receipts: Vec<_> = std::iter::from_fn(|| receipts_rx.try_recv().ok()).collect();
                panic!("public request must reach account eleven: {error}; captured {receipts:?}")
            });
        let raw = reply.text().await.expect("successful public response body");
        let response = if stream {
            let event = raw
                .lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter_map(|data| serde_json::from_str::<Value>(data).ok())
                .find(|event| event["type"] == "response.completed")
                .unwrap_or_else(|| panic!("missing completed event in streamed reply: {raw}"));
            event["response"].clone()
        } else {
            serde_json::from_str(&raw)
                .unwrap_or_else(|error| panic!("invalid JSON response {error}: {raw}"))
        };
        assert_eq!(response["status"], "completed");
        let texts: Vec<_> = response["output"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|item| {
                if item["type"] == "output_text" {
                    vec![item]
                } else if item["type"] == "message" {
                    item["content"].as_array().into_iter().flatten().collect()
                } else {
                    Vec::new()
                }
            })
            .filter(|part| part["type"] == "output_text")
            .map(|part| part["text"].as_str().unwrap())
            .collect();
        assert_eq!(
            texts,
            vec!["pool success"],
            "exact business text: {response}"
        );

        let expected_identities = ACCOUNTS
            .iter()
            .map(|account| format!("poolpeer:model:{account}"))
            .collect::<Vec<_>>();
        let mut received = Vec::new();
        for _ in 0..11 {
            received.push(
                receipts_rx
                    .recv()
                    .await
                    .expect("eleventh success must complete"),
            );
        }
        assert_eq!(received.len(), 11, "exactly eleven business sends");
        assert!(received.iter().all(|receipt| receipt.valid_payload));
        assert!(receipts_rx.try_recv().is_err(), "no duplicate send");
        assert_eq!(
            received
                .iter()
                .map(|receipt| receipt.identity.clone())
                .collect::<std::collections::BTreeSet<_>>(),
            expected_identities.into_iter().collect()
        );
        assert_eq!(
            received
                .iter()
                .map(|receipt| receipt.index)
                .collect::<Vec<_>>(),
            (1..=11).collect::<Vec<_>>()
        );
        for receipt in &received {
            assert!(ACCOUNTS
                .iter()
                .any(|account| receipt.authorization == bearer(account)));
            assert_eq!(receipt.model, "wire-pool-model");
            assert!(receipt.body["stream"] == json!(stream));
        }
        server.shutdown().await;
        peer_task.abort();
    }
}

async fn run_all_fail(mode: Mode) {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    let (receipts_tx, mut receipts_rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route(peer_route(mode), post(peer_provider))
        .with_state(Peer {
            receipts: receipts_tx,
            scenario: Scenario::AllFail,
            send_count: Arc::new(AtomicUsize::new(0)),
            mode,
        });
    let peer_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let server = spawn_v3_server_aggregate(manifest(free_port(), peer_port, 11, mode))
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", server.listeners[0].addr);

    let result = client.post(&endpoint).json(&request(false)).send().await;
    let raw = match result {
        Err(_) => String::new(),
        Ok(reply) => {
            assert!(
                !reply.status().is_success(),
                "all-key exhaustion cannot fabricate success"
            );
            reply.text().await.unwrap()
        }
    };
    assert!(
        !raw.contains("Endpoint is unavailable") && !raw.contains("server_error"),
        "provider HTTP error body reached client: {raw}"
    );

    let received: Vec<_> = std::iter::from_fn(|| receipts_rx.try_recv().ok()).collect();
    assert_eq!(received.len(), 11, "all eleven keys must be tried");
    assert!(receipts_rx.try_recv().is_err(), "no extra candidate send");
    assert!(received.iter().all(|receipt| receipt.valid_payload));
    assert_eq!(
        received
            .iter()
            .map(|receipt| receipt.identity.clone())
            .collect::<std::collections::BTreeSet<_>>(),
        ACCOUNTS
            .iter()
            .map(|account| format!("poolpeer:model:{account}"))
            .collect::<std::collections::BTreeSet<_>>()
    );
    server.shutdown().await;
    peer_task.abort();
}

async fn run_budget_eight(mode: Mode) {
    let _test_guard = TEST_LOCK.lock().await;
    let _counter = CounterEnvironment::new();
    let (receipts_tx, mut receipts_rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route(peer_route(mode), post(peer_provider))
        .with_state(Peer {
            receipts: receipts_tx,
            scenario: Scenario::BudgetEightFail,
            send_count: Arc::new(AtomicUsize::new(0)),
            mode,
        });
    let peer_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let server = spawn_v3_server_aggregate(manifest(free_port(), peer_port, 8, mode))
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap();
    let endpoint = format!("http://{}/v1/responses", server.listeners[0].addr);

    let result = client.post(&endpoint).json(&request(false)).send().await;
    let raw = match result {
        Err(_) => String::new(),
        Ok(reply) => {
            assert!(
                !reply.status().is_success(),
                "local budget stop cannot fabricate success"
            );
            reply.text().await.unwrap()
        }
    };
    assert!(
        !raw.contains("Endpoint is unavailable") && !raw.contains("server_error"),
        "provider HTTP error body reached client: {raw}"
    );

    let received: Vec<_> = std::iter::from_fn(|| receipts_rx.try_recv().ok()).collect();
    assert_eq!(received.len(), 8, "declared budget must permit eight sends");
    assert!(
        receipts_rx.try_recv().is_err(),
        "declared budget 8 must stop before keys 9-11"
    );
    assert!(received.iter().all(|receipt| receipt.valid_payload));
    assert_eq!(
        received
            .iter()
            .map(|receipt| &receipt.identity)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        8,
        "eight independent identities before local budget stop"
    );
    server.shutdown().await;
    peer_task.abort();
}

#[tokio::test]
async fn pool_11_first_10_fail_11_succeeds_direct() {
    run_json_sse_success(Scenario::FirstTenFail, Mode::Direct).await
}

#[tokio::test]
async fn pool_11_first_10_fail_11_succeeds_relay() {
    run_json_sse_success(Scenario::FirstTenFail, Mode::Relay).await
}

#[tokio::test]
async fn pool_11_all_fail_real_exhaustion_direct() {
    run_all_fail(Mode::Direct).await
}

#[tokio::test]
async fn pool_11_all_fail_real_exhaustion_relay() {
    run_all_fail(Mode::Relay).await
}

#[tokio::test]
async fn pool_declared_budget_8_local_exhaustion_direct() {
    run_budget_eight(Mode::Direct).await
}

#[tokio::test]
async fn pool_declared_budget_8_local_exhaustion_relay() {
    run_budget_eight(Mode::Relay).await
}
