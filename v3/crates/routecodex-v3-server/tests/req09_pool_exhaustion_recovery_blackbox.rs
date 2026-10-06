//! REQ09 public pool-exhaustion and independent recovery consumer.
//!
//! This test uses the real aggregate server, public Responses and OpenAI Chat
//! Relay entries, real loopback provider upstreams, and the real admin
//! cooldown-probe path. It asserts the externally visible contract:
//!
//! 1. a controlled provider 503 cools the only eligible provider identity;
//! 2. the current client request terminates as a transport failure before
//!    recovery, with no HTTP error response and no fabricated success;
//! 3. a request that begins with the pool already cooled also terminates as a
//!    transport failure before recovery and never resumes at the upstream once
//!    recovery happens. The cross-protocol case is a legal OpenAI Chat ->
//!    Responses Relay request built from ordinary messages; it does not
//!    fabricate remote history or output items;
//! 4. provider management remains alive, and the public admin probe path can
//!    perform a semantic recovery probe after the upstream becomes healthy;
//! 5. a new client request succeeds after the probe clears the cooldown.
//!
//! The bounded first-request wait is failure detection. It is never treated as
//! a successful disconnect. The test records that timeout, tears the client
//! task down, and lets the remaining assertions report the contract failure.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{
    env,
    ffi::OsString,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    time::{sleep, timeout, Instant},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const PROVIDER_ID: &str = "req09_exhaustion_provider";
const AUTH_ALIAS: &str = "req09_exhaustion_key";
const MODEL_ID: &str = "req09_exhaustion_wire";
const CLIENT_MODEL: &str = "req09-pool-exhaustion-client";
const PROVIDER_KEY_ENV: &str = "V3_REQ09_POOL_EXHAUSTION_RECOVERY_KEY";
const FIRST_REQUEST_MARKER: &str = "REQ09_POOL_EXHAUSTION_FIRST_REQUEST";
const NEW_REQUEST_MARKER: &str = "REQ09_POOL_EXHAUSTION_NEW_REQUEST";
const ALREADY_COOLED_REQUEST_MARKER: &str = "REQ09_POOL_EXHAUSTION_ALREADY_COOLED_REQUEST";
const HEALTHY_TEXT: &str = "req09 pool exhaustion recovery ok";
const DISCONNECT_BUDGET: Duration = Duration::from_millis(1_500);
const RECOVERY_DEADLINE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
enum PoolExhaustionCase {
    DirectResponses,
    RelayResponsesToOpenAiChat,
    RelayOpenAiChatToResponses,
}

impl PoolExhaustionCase {
    fn label(self) -> &'static str {
        match self {
            Self::DirectResponses => "direct-responses",
            Self::RelayResponsesToOpenAiChat => "relay-responses-to-openai-chat",
            Self::RelayOpenAiChatToResponses => "relay-openai-chat-to-responses",
        }
    }

    fn entry_protocol(self) -> &'static str {
        match self {
            Self::DirectResponses | Self::RelayResponsesToOpenAiChat => "responses",
            Self::RelayOpenAiChatToResponses => "openai_chat",
        }
    }

    fn client_path(self) -> &'static str {
        match self {
            Self::DirectResponses | Self::RelayResponsesToOpenAiChat => "/v1/responses",
            Self::RelayOpenAiChatToResponses => "/v1/chat/completions",
        }
    }

    fn provider_type(self) -> &'static str {
        match self {
            Self::DirectResponses | Self::RelayOpenAiChatToResponses => "responses",
            Self::RelayResponsesToOpenAiChat => "openai_chat",
        }
    }

    fn upstream_path(self) -> &'static str {
        match self {
            Self::DirectResponses | Self::RelayOpenAiChatToResponses => "/v1/responses",
            Self::RelayResponsesToOpenAiChat => "/v1/chat/completions",
        }
    }

    fn hub_declaration(self) -> String {
        let declaration = hub_v1_test_declaration();
        match self {
            Self::DirectResponses => declaration,
            Self::RelayResponsesToOpenAiChat => {
                let responses_direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
                let responses_relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
                declaration.replace(responses_direct, responses_relay)
            }
            Self::RelayOpenAiChatToResponses => {
                let openai_chat_direct = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
                let openai_chat_relay = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
                declaration.replace(openai_chat_direct, openai_chat_relay)
            }
        }
    }

    fn healthy_response(self) -> Value {
        match self {
            Self::DirectResponses | Self::RelayOpenAiChatToResponses => json!({
                "id": "resp_req09_pool_exhaustion_recovery",
                "object": "response",
                "status": "completed",
                "output_text": HEALTHY_TEXT,
                "output": [{"type": "output_text", "text": HEALTHY_TEXT}],
                "error": null,
            }),
            Self::RelayResponsesToOpenAiChat => json!({
                "id": "chatcmpl_req09_pool_exhaustion_recovery",
                "object": "chat.completion",
                "created": 0,
                "model": MODEL_ID,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": HEALTHY_TEXT},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
            }),
        }
    }
}

struct TestHomeGuard {
    previous_home: Option<OsString>,
    previous_provider_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = env::temp_dir().join(format!(
            "routecodex-v3-req09-pool-exhaustion-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        let previous_home = env::var_os("HOME");
        let previous_provider_key = env::var_os(PROVIDER_KEY_ENV);
        env::set_var("HOME", &path);
        env::set_var(PROVIDER_KEY_ENV, "req09-pool-exhaustion-controlled-secret");
        Self {
            previous_home,
            previous_provider_key,
            path,
        }
    }

    fn config_path(&self) -> PathBuf {
        self.path.join("config.v3.toml")
    }

    fn admin_token(&self) -> String {
        fs::read_to_string(self.path.join("state").join("admin-token"))
            .expect("admin entry must provision its local token")
            .trim()
            .to_string()
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        match &self.previous_home {
            Some(previous) => env::set_var("HOME", previous),
            None => env::remove_var("HOME"),
        }
        match &self.previous_provider_key {
            Some(previous) => env::set_var(PROVIDER_KEY_ENV, previous),
            None => env::remove_var(PROVIDER_KEY_ENV),
        }
        fs::remove_dir_all(&self.path).expect("remove this test's isolated HOME");
    }
}

#[derive(Clone)]
struct UpstreamState {
    case: PoolExhaustionCase,
    captures: mpsc::UnboundedSender<Value>,
    recover: Arc<AtomicBool>,
}

async fn capture_provider_request(
    State(state): State<Arc<UpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let healthy = state.recover.load(Ordering::SeqCst);
    state
        .captures
        .send(json!({
            "healthy": healthy,
            "body": body,
        }))
        .expect("capture receiver remains live");

    if healthy {
        let payload = state.case.healthy_response();
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&payload).unwrap()))
            .unwrap()
    } else {
        Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .header("content-type", "application/json")
            .header("x-request-id", "req09-pool-exhaustion-upstream")
            .body(Body::from(
                r#"{"error":{"message":"controlled exhaustion","type":"server_error","code":"controlled_exhaustion"}}"#,
            ))
            .unwrap()
    }
}

async fn start_upstream(
    case: PoolExhaustionCase,
) -> (
    String,
    mpsc::UnboundedReceiver<Value>,
    Arc<AtomicBool>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let recover = Arc::new(AtomicBool::new(false));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(case.upstream_path(), post(capture_provider_request))
        .with_state(Arc::new(UpstreamState {
            case,
            captures: captures_tx,
            recover: Arc::clone(&recover),
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (
        format!("http://{address}/v1"),
        captures_rx,
        recover,
        shutdown_tx,
        task,
    )
}

fn config_source(
    case: PoolExhaustionCase,
    server_port: u16,
    admin_port: u16,
    upstream_base_url: &str,
) -> String {
    let hub_declaration = case.hub_declaration();
    let server_execution = hub_v1_server_execution("req09_pool_exhaustion");
    let provider_type = case.provider_type();
    let entry_protocol = case.entry_protocol();
    format!(
        r#"
version = 3
{hub_declaration}

[servers.req09_pool_exhaustion]
bind = "127.0.0.1"
port = {server_port}
routing_group = "req09_pool_exhaustion"
endpoints = ["{entry_protocol}"]
{server_execution}

[servers.req09_pool_exhaustion.execution.attempt_store]
residence_timeout_ms = 5000

[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}

[providers.{PROVIDER_ID}]
type = "{provider_type}"
base_url = "{upstream_base_url}"
default_model = "{MODEL_ID}"
auth = {{ type = "api_key", entries = [{{ alias = "{AUTH_ALIAS}", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000, probe_interval_ms = 60000 }}

[providers.{PROVIDER_ID}.models.{MODEL_ID}]
wire_name = "{MODEL_ID}"
aliases = ["{CLIENT_MODEL}"]
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[debug]
log_console = false
snapshots = true
codex_samples = true
snapshot_stages = "client-request,client-response"
dry_run = false
retention = {{ raw_requests = 16, raw_responses = 16, events = 256 }}

[route_groups.req09_pool_exhaustion.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "{entry_protocol}", models = ["{CLIENT_MODEL}"] }}
targets = [{{ kind = "provider_model", provider = "{PROVIDER_ID}", model = "{MODEL_ID}", key = "{AUTH_ALIAS}", priority = 1 }}]

[route_groups.req09_pool_exhaustion.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{PROVIDER_ID}", model = "{MODEL_ID}", key = "{AUTH_ALIAS}", priority = 1 }}]
"#
    )
}

fn client_request(case: PoolExhaustionCase, marker: &str) -> Value {
    match case {
        PoolExhaustionCase::RelayOpenAiChatToResponses => json!({
            "model": CLIENT_MODEL,
            "stream": false,
            "messages": [{
                "role": "user",
                "content": marker,
            }],
        }),
        PoolExhaustionCase::DirectResponses | PoolExhaustionCase::RelayResponsesToOpenAiChat => {
            json!({
                "model": CLIENT_MODEL,
                "stream": false,
                "input": [{
                    "role": "user",
                    "content": [{"type": "input_text", "text": marker}],
                }],
            })
        }
    }
}

fn already_cooled_request(case: PoolExhaustionCase) -> Value {
    client_request(case, ALREADY_COOLED_REQUEST_MARKER)
}

#[derive(Debug)]
enum FirstClientOutcome {
    Response { status: u16, body: String },
    TransportError { is_status: bool, message: String },
}

async fn first_client_request(endpoint: String, body: Value) -> FirstClientOutcome {
    let client = reqwest::Client::new();
    match client
        .post(&endpoint)
        .header("x-routecodex-session-id", format!("req09-pool:{endpoint}"))
        .json(&body)
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = timeout(Duration::from_secs(1), response.text())
                .await
                .unwrap_or_else(|_| Ok(String::new()))
                .unwrap_or_default();
            FirstClientOutcome::Response { status, body }
        }
        Err(error) => FirstClientOutcome::TransportError {
            is_status: error.is_status(),
            message: error.to_string(),
        },
    }
}

fn capture_text(capture: &Value) -> String {
    capture["body"].to_string()
}

fn cooldown_entry_matches_identity(entry: &Value) -> bool {
    entry["provider_id"] == json!(PROVIDER_ID)
        && entry["auth_alias"] == json!(AUTH_ALIAS)
        && (entry["model_id"] == Value::Null || entry["model_id"] == json!(MODEL_ID))
}

fn cooldown_identity_is_present(pool: &Value) -> bool {
    pool["listeners"].as_array().is_some_and(|listeners| {
        listeners.iter().any(|listener| {
            listener["entries"]
                .as_array()
                .is_some_and(|entries| entries.iter().any(cooldown_entry_matches_identity))
        })
    })
}

fn cooldown_identity_is_clear(pool: &Value) -> bool {
    let Some(listeners) = pool["listeners"].as_array() else {
        return false;
    };
    listeners.iter().all(|listener| {
        listener["entries"].as_array().is_none_or(|entries| {
            entries
                .iter()
                .all(|entry| !cooldown_entry_matches_identity(entry))
        })
    })
}

async fn read_admin_json(
    client: &reqwest::Client,
    admin_base: &str,
    token: &str,
    path: &str,
) -> (u16, Value) {
    let Ok(response) = client
        .get(format!("{admin_base}{path}"))
        .header("x-routecodex-admin-token", token)
        .send()
        .await
    else {
        return (0, Value::Null);
    };
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let value = serde_json::from_str(&body).unwrap_or(Value::Null);
    (status, value)
}

async fn shutdown_upstream(shutdown: oneshot::Sender<()>, task: &mut tokio::task::JoinHandle<()>) {
    let _ = shutdown.send(());
    if timeout(Duration::from_secs(5), &mut *task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

#[tokio::test]
async fn req09_pool_exhaustion_disconnects_then_recovers_for_a_new_request_blackbox() {
    run_pool_exhaustion_case(PoolExhaustionCase::DirectResponses).await;
}

#[tokio::test]
async fn req09_pool_exhaustion_relay_responses_to_openai_chat_disconnects_then_recovers_blackbox() {
    run_pool_exhaustion_case(PoolExhaustionCase::RelayResponsesToOpenAiChat).await;
}

#[tokio::test]
async fn req09_pool_exhaustion_relay_openai_chat_to_responses_disconnects_before_recovery_blackbox()
{
    run_pool_exhaustion_case(PoolExhaustionCase::RelayOpenAiChatToResponses).await;
}

async fn run_pool_exhaustion_case(case: PoolExhaustionCase) {
    let _guard = TEST_LOCK.lock().await;
    let home = TestHomeGuard::new(case.label());

    let (upstream_base_url, mut captures, recover, upstream_shutdown, mut upstream_task) =
        start_upstream(case).await;
    let server_port = free_port();
    let admin_port = free_port();
    let config_path = home.config_path();
    fs::write(
        &config_path,
        config_source(case, server_port, admin_port, &upstream_base_url),
    )
    .unwrap();

    let snapshot = V3ConfigStore::new(&config_path)
        .load_snapshot_with_source_identity()
        .expect("isolated config must compile");
    let handle = spawn_v3_server_aggregate_with_admin(
        snapshot.manifest,
        snapshot.admin_webui,
        Some(config_path),
    )
    .await
    .expect("real aggregate server must start");
    let server_addr = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "req09_pool_exhaustion")
        .expect("aggregate exposes the main listener")
        .addr;
    let admin_addr = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "admin_webui")
        .expect("aggregate exposes the admin listener")
        .addr;
    let admin_base = format!("http://{admin_addr}");
    let token = home.admin_token();
    let client = reqwest::Client::new();

    let mut first_task = tokio::spawn(first_client_request(
        format!("http://{server_addr}{}", case.client_path()),
        client_request(case, FIRST_REQUEST_MARKER),
    ));
    let first_capture = timeout(Duration::from_secs(3), captures.recv())
        .await
        .ok()
        .flatten();
    let first_outcome_before_recovery = timeout(DISCONNECT_BUDGET, &mut first_task).await;

    let first_finished_before_recovery = first_outcome_before_recovery.is_ok();
    let mut first_join_error = None;
    let first_outcome = match first_outcome_before_recovery {
        Ok(Ok(outcome)) => Some(outcome),
        Ok(Err(error)) => {
            first_join_error = Some(error.to_string());
            None
        }
        Err(_) => None,
    };
    if !first_finished_before_recovery {
        first_task.abort();
        let _ = first_task.await;
    }

    let mut cooled_identity_seen = false;
    let mut pool_before_recovery = Value::Null;
    let cooldown_deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < cooldown_deadline {
        let (pool_status, pool_body) = read_admin_json(
            &client,
            &admin_base,
            &token,
            "/api/observability/cooldown-pool",
        )
        .await;
        if pool_status == 200 {
            pool_before_recovery = pool_body.clone();
            cooled_identity_seen = cooldown_identity_is_present(&pool_body);
        }
        if cooled_identity_seen {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }

    // Issue a second request while the pool is already fully cooled
    // (cooldown-only exhaustion). The contract requires this request to
    // transport-disconnect promptly, before recovery. It must never be held
    // and later resumed when the probe clears the cooldown. The task is left
    // running on timeout so that a buggy resumption stays observable below.
    let mut cooled_task = tokio::spawn(first_client_request(
        format!("http://{server_addr}{}", case.client_path()),
        already_cooled_request(case),
    ));
    let cooled_outcome_before_recovery = timeout(DISCONNECT_BUDGET, &mut cooled_task).await;
    let cooled_finished_before_recovery = cooled_outcome_before_recovery.is_ok();
    let mut cooled_join_error = None;
    let mut cooled_outcome = match cooled_outcome_before_recovery {
        Ok(Ok(outcome)) => Some(outcome),
        Ok(Err(error)) => {
            cooled_join_error = Some(error.to_string());
            None
        }
        Err(_) => None,
    };

    recover.store(true, Ordering::SeqCst);
    let mut probe_transport_error = None;
    let probe_response = match client
        .post(format!(
            "{admin_base}/api/observability/cooldown-pool/probe"
        ))
        .header("x-routecodex-admin-token", &token)
        .json(&json!({
            "port": server_port,
            "provider_id": PROVIDER_ID,
            "auth_alias": AUTH_ALIAS,
            "model_id": MODEL_ID,
        }))
        .send()
        .await
    {
        Ok(response) => Some(response),
        Err(error) => {
            probe_transport_error = Some(error.to_string());
            None
        }
    };
    let (probe_status, probe_body) = match probe_response {
        Some(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            (
                status,
                serde_json::from_str::<Value>(&body).unwrap_or(Value::Null),
            )
        }
        None => (0, Value::Null),
    };

    let recovery_started = Instant::now();
    let mut upstream_captures = Vec::new();
    if let Some(capture) = first_capture {
        upstream_captures.push(capture);
    }
    let mut healthy_probe_seen = false;
    let mut pool_clear = false;
    let mut final_pool = Value::Null;
    while recovery_started.elapsed() < RECOVERY_DEADLINE {
        let (pool_status, pool_body) = read_admin_json(
            &client,
            &admin_base,
            &token,
            "/api/observability/cooldown-pool",
        )
        .await;
        if pool_status == 200 {
            final_pool = pool_body.clone();
            pool_clear = cooldown_identity_is_clear(&pool_body);
        }
        if let Ok(Some(capture)) = timeout(Duration::from_millis(100), captures.recv()).await {
            if capture["healthy"] == json!(true)
                && capture_text(&capture).contains("routecodex health probe")
            {
                healthy_probe_seen = true;
            }
            upstream_captures.push(capture);
        }
        if healthy_probe_seen && pool_clear {
            break;
        }
        sleep(Duration::from_millis(50)).await;
    }

    let new_started = Instant::now();
    let new_response = timeout(
        Duration::from_secs(5),
        client
            .post(format!("http://{server_addr}{}", case.client_path()))
            .header(
                "x-routecodex-session-id",
                format!("req09-pool:http://{server_addr}{}", case.client_path()),
            )
            .json(&client_request(case, NEW_REQUEST_MARKER))
            .send(),
    )
    .await;
    let mut new_transport_error = None;
    let (new_status, new_body) = match new_response {
        Ok(Ok(response)) => {
            let status = response.status().as_u16();
            let body = timeout(Duration::from_secs(2), response.json::<Value>())
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(Value::Null);
            (Some(status), body)
        }
        Ok(Err(error)) => {
            new_transport_error = Some(error.to_string());
            (None, Value::Null)
        }
        Err(_) => (None, Value::Null),
    };

    let mut new_request_capture = None;
    let capture_deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < capture_deadline {
        if let Ok(Some(capture)) = timeout(Duration::from_millis(100), captures.recv()).await {
            if capture_text(&capture).contains(NEW_REQUEST_MARKER) {
                new_request_capture = Some(capture.clone());
            }
            upstream_captures.push(capture);
        }
        if new_request_capture.is_some() {
            break;
        }
        sleep(Duration::from_millis(25)).await;
    }

    let new_elapsed = new_started.elapsed();

    // If the runtime wrongly held the already-cooled request instead of
    // disconnecting it, recovery can resume it now. Give that resumption a
    // bounded chance so it is observable, then collect any remaining captures.
    // A correct runtime already finished this request before recovery.
    if !cooled_finished_before_recovery {
        match timeout(Duration::from_secs(2), &mut cooled_task).await {
            Ok(Ok(outcome)) => cooled_outcome = Some(outcome),
            Ok(Err(error)) => cooled_join_error = Some(error.to_string()),
            Err(_) => {}
        }
        let resume_drain_deadline = Instant::now() + Duration::from_millis(500);
        loop {
            match timeout(Duration::from_millis(100), captures.recv()).await {
                Ok(Some(capture)) => upstream_captures.push(capture),
                _ => break,
            }
            if Instant::now() >= resume_drain_deadline {
                break;
            }
        }
    }
    if !cooled_task.is_finished() {
        cooled_task.abort();
        let _ = cooled_task.await;
    }

    let persistence_failures = handle.shutdown().await;
    shutdown_upstream(upstream_shutdown, &mut upstream_task).await;
    drop(home);

    assert!(
        persistence_failures.is_empty(),
        "sample persistence failures: {persistence_failures:?}"
    );

    let first_capture = upstream_captures
        .iter()
        .find(|capture| capture_text(capture).contains(FIRST_REQUEST_MARKER))
        .unwrap_or_else(|| {
            panic!("the first provider attempt must be captured: {upstream_captures:?}")
        });
    assert_eq!(
        first_capture["healthy"], false,
        "the first provider attempt must be a real controlled failure: {first_capture}"
    );
    assert!(
        first_finished_before_recovery,
        "the current client request must terminate before recovery; it did not within {DISCONNECT_BUDGET:?}"
    );
    assert!(
        cooled_identity_seen,
        "the controlled provider failure must be visible in the public cooldown pool: {pool_before_recovery}"
    );
    assert!(
        first_join_error.is_none(),
        "the first client task must not fail: {first_join_error:?}"
    );
    match first_outcome {
        Some(FirstClientOutcome::TransportError { is_status, message }) => {
            assert!(
                !is_status,
                "the current request must not receive a projected HTTP error status: {message}"
            );
            assert!(
                !message.contains("controlled_exhaustion") && !message.contains("server_error"),
                "provider error detail must not be projected to the client: {message}"
            );
        }
        Some(FirstClientOutcome::Response { status, body }) => {
            panic!(
                "the exhausted current request must disconnect, not return HTTP {status}: {body}"
            );
        }
        None => {}
    }

    assert!(
        cooled_finished_before_recovery,
        "the already-cooled request must transport-disconnect before recovery; it did not within {DISCONNECT_BUDGET:?}"
    );
    assert!(
        cooled_join_error.is_none(),
        "the already-cooled client task must not fail: {cooled_join_error:?}"
    );
    match cooled_outcome {
        Some(FirstClientOutcome::TransportError { is_status, message }) => {
            assert!(
                !is_status,
                "the already-cooled request must not receive a projected HTTP error status: {message}"
            );
            assert!(
                !message.contains("controlled_exhaustion") && !message.contains("server_error"),
                "provider error detail must not be projected to the already-cooled client: {message}"
            );
        }
        Some(FirstClientOutcome::Response { status, body }) => {
            panic!("the already-cooled request must disconnect, not return HTTP {status}: {body}");
        }
        None => {}
    }

    assert_eq!(
        probe_status, 200,
        "the public admin probe action must be accepted: {probe_body}"
    );
    assert!(
        probe_transport_error.is_none(),
        "the public admin probe action must reach the listener: {probe_transport_error:?}"
    );
    assert_eq!(
        probe_body["scheduled"], true,
        "the cooled identity must schedule the existing semantic probe: {probe_body}"
    );
    assert!(
        healthy_probe_seen,
        "a real semantic probe must reach the recovered upstream: {upstream_captures:?}"
    );
    assert!(
        pool_clear,
        "the successful probe must clear the cooled identity: {final_pool}"
    );
    assert_eq!(
        new_status,
        Some(200),
        "a new request must succeed after probe recovery: {new_body}"
    );
    assert!(
        new_transport_error.is_none(),
        "the new client request must not fail at the transport: {new_transport_error:?}"
    );
    match case {
        PoolExhaustionCase::RelayOpenAiChatToResponses => {
            assert_eq!(
                new_body["object"], "chat.completion",
                "the new cross-protocol request must receive a completed Chat payload: {new_body}"
            );
        }
        PoolExhaustionCase::DirectResponses | PoolExhaustionCase::RelayResponsesToOpenAiChat => {
            assert_eq!(
                new_body["status"], "completed",
                "the new request must receive a completed Responses payload: {new_body}"
            );
        }
    }
    assert!(
        new_body.to_string().contains(HEALTHY_TEXT),
        "the new request must receive the healthy provider payload: {new_body}"
    );
    assert!(
        !new_body.to_string().contains("controlled_exhaustion")
            && new_body.get("error").is_none_or(Value::is_null)
            && new_body["type"] != "error",
        "the recovered request must not carry an error payload: {new_body}"
    );
    assert!(
        new_request_capture
            .as_ref()
            .is_some_and(|capture| capture["healthy"] == json!(true)
                && capture_text(capture).contains(NEW_REQUEST_MARKER)),
        "the new request must reach the healthy upstream with its marker: {upstream_captures:?}"
    );
    assert!(
        new_elapsed < Duration::from_secs(5),
        "the recovered request must not wait for a future recovery cycle: {new_elapsed:?}"
    );
    assert!(
        !upstream_captures
            .iter()
            .any(|capture| capture_text(capture).contains(ALREADY_COOLED_REQUEST_MARKER)),
        "the already-cooled request must never resume at the upstream after recovery: {upstream_captures:?}"
    );
}
