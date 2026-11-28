//! Public-entry black-box regression for canonical issue `23fe689`.
//!
//! Stable test IDs:
//! `issue23fe689_openai_chat_direct_provider_terminal_ledger_terminal`,
//! `issue23fe689_openai_chat_relay_provider_terminal_ledger_terminal`,
//! `issue23fe689_anthropic_direct_provider_terminal_ledger_terminal`,
//! `issue23fe689_anthropic_relay_provider_terminal_ledger_terminal`,
//! `issue23fe689_gemini_direct_provider_terminal_ledger_terminal`, and
//! `issue23fe689_gemini_relay_provider_terminal_ledger_terminal`.
//! `issue23fe689_recovered_candidate_is_not_closed_early` is the positive
//! control: a failed candidate with a healthy successor must still complete.
//! `issuedd1de7e_responses_relay_provider_http_400_terminal_provenance` and
//! `issuedd1de7e_responses_relay_provider_http_400_recovers_eligible_sibling`
//! pin the Responses Relay HTTP 400 provenance and sibling-recovery controls.
//!
//! Command:
//! `node scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test issue23fe689_provider_terminal_ledger_row -- --nocapture --test-threads=1`
//!
//! Before this issue, the non-Responses entries broke the client transport on a
//! provider terminal but never wrote a request-ledger terminal row. The
//! register reproduced it with a sole `openai_chat` Direct candidate answering
//! HTTP 429: the client observed `ECONNRESET`, and the ledger kept only
//! `request.started`, `request.route_selected`, and
//! `request.provider_attempt_failed`.
//!
//! These fixtures enter the real aggregate server for each protocol and assert:
//! - exactly one terminal row, `request.failed`, with the real provider status
//!   and error category;
//! - the final genuine Provider HTTP error reaches the client without becoming
//!   a fabricated success or proxy error.

use axum::{
    body::Body,
    extract::State,
    http::StatusCode,
    response::Response,
    routing::{any, post},
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    time::{sleep, Instant},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "ISSUE_23FE689_PROVIDER_KEY";

#[derive(Clone, Copy)]
enum Entry {
    Chat,
    Anthropic,
    Gemini,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Direct,
    Relay,
}

impl Entry {
    fn endpoint(self) -> &'static str {
        match self {
            Entry::Chat => "/v1/chat/completions",
            Entry::Anthropic => "/v1/messages",
            Entry::Gemini => "/v1beta/models/gemini-client:generateContent",
        }
    }

    fn request(self) -> Value {
        match self {
            Entry::Chat => json!({
                "model": "chat-client",
                "messages": [{ "role": "user", "content": "provider 429 terminal row" }],
                "stream": false
            }),
            Entry::Anthropic => json!({
                "model": "anthropic-client",
                "max_tokens": 32,
                "messages": [{ "role": "user", "content": "provider 429 terminal row" }],
                "stream": false
            }),
            Entry::Gemini => json!({
                "contents": [{ "role": "user", "parts": [{ "text": "provider 429 terminal row" }] }]
            }),
        }
    }
}

struct ProviderCallCount(AtomicU64);

async fn provider_429(
    axum::extract::State(calls): axum::extract::State<Arc<ProviderCallCount>>,
) -> Response<axum::body::Body> {
    calls.0.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::TOO_MANY_REQUESTS)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            r#"{"error":{"type":"rate_limit_error","message":"raw provider secret detail"}}"#,
        ))
        .unwrap()
}

async fn start_provider_429() -> (
    u16,
    Arc<ProviderCallCount>,
    tokio::sync::oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(ProviderCallCount(AtomicU64::new(0)));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .fallback(any(provider_429))
        .with_state(Arc::clone(&calls));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (address.port(), calls, shutdown_tx)
}

async fn provider_chat_success() -> Response<axum::body::Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            serde_json::to_vec(&json!({
                "id": "chatcmpl-recovered",
                "object": "chat.completion",
                "model": "chat-wire",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "recovered-business-response" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 }
            }))
            .unwrap(),
        ))
        .unwrap()
}

async fn start_provider_success() -> (u16, tokio::sync::oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new().fallback(any(provider_chat_success));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (address.port(), shutdown_tx)
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
    entry: Entry,
    mode: Mode,
    recovery_port: Option<u16>,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    let anthropic_direct_binding = r#"{ entry_protocol = "anthropic", endpoint_patterns = ["/v1/messages"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_anthropic_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let anthropic_relay_binding = r#"{ entry_protocol = "anthropic", endpoint_patterns = ["/v1/messages"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_anthropic_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs" }"#;
    let gemini_direct_binding = r#"{ entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "direct", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending or direct runtime.", runtime_owner_symbol = "execute_v3_gemini_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let gemini_relay_binding = r#"{ entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "relay", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending or direct runtime.", runtime_owner_symbol = "execute_v3_gemini_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs" }"#;
    let hub_v1_declaration = hub_v1_fixture::hub_v1_test_declaration();
    let hub_v1_declaration = match (entry, mode) {
        (Entry::Chat, Mode::Direct) => hub_v1_declaration.replace(relay_binding, direct_binding),
        (Entry::Chat, Mode::Relay) => hub_v1_declaration.replace(direct_binding, relay_binding),
        (Entry::Anthropic, Mode::Direct) => {
            hub_v1_declaration.replace(anthropic_relay_binding, anthropic_direct_binding)
        }
        (Entry::Anthropic, Mode::Relay) => {
            hub_v1_declaration.replace(anthropic_direct_binding, anthropic_relay_binding)
        }
        (Entry::Gemini, Mode::Direct) => {
            hub_v1_declaration.replace(gemini_relay_binding, gemini_direct_binding)
        }
        (Entry::Gemini, Mode::Relay) => {
            hub_v1_declaration.replace(gemini_direct_binding, gemini_relay_binding)
        }
    };
    let endpoint = match entry {
        Entry::Chat => "openai_chat",
        Entry::Anthropic => "anthropic",
        Entry::Gemini => "gemini",
    };
    let wire_model = match entry {
        Entry::Chat => "chat-wire",
        Entry::Anthropic => "anthropic-wire",
        Entry::Gemini => "gemini-wire",
    };
    let client_model = match entry {
        Entry::Chat => "chat-client",
        Entry::Anthropic => "anthropic-client",
        Entry::Gemini => "gemini-client",
    };
    let recovery_provider = recovery_port
        .map(|port| {
            format!(
                r#"
[providers.recovery]
type = "{endpoint}"
base_url = "http://127.0.0.1:{port}/recovery"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "recovery", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.recovery.models.{wire_model}]
wire_name = "{wire_model}"
aliases = ["{client_model}"]
supports_streaming = true
capabilities = ["text"]
"#
            )
        })
        .unwrap_or_default();
    let recovery_target = recovery_port
        .map(|_| {
            format!(
                r#", {{ kind = "provider_model", provider = "recovery", model = "{wire_model}", key = "recovery", priority = 1 }}"#
            )
        })
        .unwrap_or_default();
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.ledger]
bind = "127.0.0.1"
port = {server_port}
routing_group = "ledger"
endpoints = ["{endpoint}"]

{server_execution}

[providers.controlled]
type = "{provider_type}"
base_url = "http://127.0.0.1:{upstream_port}/controlled"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}

[providers.controlled.models.{wire_model}]
wire_name = "{wire_model}"
aliases = ["{client_model}"]
supports_streaming = true
capabilities = ["text"]

{recovery_provider}

[route_groups.ledger.pools.client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "{entry_protocol}", models = ["{client_model}"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "{wire_model}", key = "controlled", priority = 2 }}{recovery_target}]

[route_groups.ledger.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "{wire_model}", key = "controlled", priority = 2 }}{recovery_target}]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_fixture::hub_v1_server_execution("ledger"),
        provider_type = endpoint,
        wire_model = wire_model,
        client_model = client_model,
        entry_protocol = endpoint,
        auth_env = AUTH_ENV,
        recovery_provider = recovery_provider,
        recovery_target = recovery_target,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn request_records_path(home: &std::path::Path, port: u16) -> PathBuf {
    home.join(".rcc")
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"))
}

fn read_rows(path: &std::path::Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|line| line.get("row").cloned())
        .collect()
}

fn read_rows_strict(path: &std::path::Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .unwrap_or_else(|error| panic!("invalid request-record line: {error}: {line}"))
        })
        .map(|line| {
            line.get("row")
                .cloned()
                .unwrap_or_else(|| panic!("request-record line has no row: {line}"))
        })
        .collect()
}

fn is_terminal(row: &Value) -> bool {
    matches!(
        row["event_type"].as_str(),
        Some("request.completed" | "request.failed" | "request.cancelled")
    )
}

async fn assert_entry_writes_one_failed_terminal(entry: Entry, mode: Mode) {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    std::env::set_var(AUTH_ENV, "controlled-fixture-secret");

    let (upstream_port, calls, upstream_shutdown) = start_provider_429().await;
    let server_port = test_ports::free_port();
    let handle = spawn_v3_server_aggregate(manifest(server_port, upstream_port, entry, mode, None))
        .await
        .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let response = client
        .post(format!("{base}{}", entry.endpoint()))
        .json(&entry.request())
        .send()
        .await;
    response.expect_err(
        "the final real Provider HTTP error must break transport without reaching the client",
    );

    assert_eq!(
        calls.0.load(Ordering::SeqCst),
        1,
        "the sole candidate must be attempted exactly once"
    );
    let debug = client
        .get(format!("{base}/_routecodex/debug/logs"))
        .send()
        .await
        .expect("the public debug log endpoint must remain available")
        .error_for_status()
        .expect("the public debug log endpoint must return its event projection")
        .json::<Value>()
        .await
        .expect("the public debug log projection must be valid JSON");
    let observed_modes = debug["logs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|event| {
            event["node_id"] == "V3Server03HttpRequestRaw"
                && event["details"]["path"] == entry.endpoint()
        })
        .filter_map(|event| event["details"]["execution_mode"].as_str())
        .collect::<Vec<_>>();
    let expected_mode = match mode {
        Mode::Direct => "direct",
        Mode::Relay => "relay",
    };
    assert_eq!(
        observed_modes,
        [expected_mode],
        "the public request must enter its declared execution mode"
    );

    let records_path = request_records_path(&home, server_port);
    let deadline = Instant::now() + Duration::from_secs(20);
    let rows = loop {
        let rows = read_rows_strict(&records_path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };

    eprintln!(
        "[issue23fe689] entry={:?} mode={mode:?} client=provider_http_429",
        entry.endpoint(),
    );
    eprintln!(
        "[issue23fe689] event_types={:?}",
        rows.iter()
            .map(|row| row["event_type"].as_str().unwrap_or("?"))
            .collect::<Vec<_>>()
    );

    let terminal_rows = rows
        .iter()
        .filter(|row| is_terminal(row))
        .collect::<Vec<_>>();
    assert_eq!(
        terminal_rows.len(),
        1,
        "the provider-terminal transport break must write exactly one terminal row: {rows:#?}"
    );
    let terminal_row = terminal_rows[0];
    assert_eq!(
        terminal_row["event_type"], "request.failed",
        "a provider exhaustion is a failed terminal, not a fabricated success"
    );
    assert_eq!(
        terminal_row["result"], "error",
        "the terminal row must record the failed result"
    );
    assert_eq!(
        terminal_row["meta"]["provider_status"], 429,
        "the terminal row must keep the real provider status"
    );
    assert_eq!(
        terminal_row["meta"]["error_category"], "http_429",
        "the terminal row must keep the real provider error category"
    );
    assert!(
        !rows
            .iter()
            .any(|row| row["event_type"] == "request.completed"),
        "the exhausted floor must not fabricate request.completed: {rows:#?}"
    );

    handle.shutdown().await;
    let _ = upstream_shutdown.send(());
    std::env::remove_var(AUTH_ENV);
    drop(home_guard);
}

async fn assert_failed_candidate_recovers() {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    std::env::set_var(AUTH_ENV, "controlled-fixture-secret");

    let (failed_port, failed_calls, failed_shutdown) = start_provider_429().await;
    let (recovery_port, recovery_shutdown) = start_provider_success().await;
    let server_port = test_ports::free_port();
    let handle = spawn_v3_server_aggregate(manifest(
        server_port,
        failed_port,
        Entry::Chat,
        Mode::Direct,
        Some(recovery_port),
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let response = client
        .post(format!("{base}{}", Entry::Chat.endpoint()))
        .json(&Entry::Chat.request())
        .send()
        .await
        .expect("the healthy recovery candidate must complete the request");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(
        body.contains("recovered-business-response"),
        "the recovery candidate business response must reach the client: {body:?}"
    );
    assert!(
        !body.contains("raw provider secret detail"),
        "the failed candidate payload must not reach the client: {body:?}"
    );
    assert_eq!(
        failed_calls.0.load(Ordering::SeqCst),
        1,
        "the failed candidate must be attempted exactly once"
    );

    let records_path = request_records_path(&home, server_port);
    let deadline = Instant::now() + Duration::from_secs(20);
    let rows = loop {
        let rows = read_rows(&records_path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };
    let terminal_rows = rows
        .iter()
        .filter(|row| is_terminal(row))
        .collect::<Vec<_>>();
    assert_eq!(
        terminal_rows.len(),
        1,
        "a recovered request must write exactly one terminal row: {rows:#?}"
    );
    assert_eq!(
        terminal_rows[0]["event_type"], "request.completed",
        "a healthy successor must not be closed as a failed terminal: {rows:#?}"
    );
    assert_eq!(terminal_rows[0]["result"], "success");
    assert!(
        rows.iter()
            .any(|row| row["event_type"] == "request.provider_attempt_failed"),
        "the failed first attempt must remain independently visible: {rows:#?}"
    );
    assert!(
        !rows.iter().any(|row| row["event_type"] == "request.failed"),
        "a request with a recovery opportunity must not be closed early: {rows:#?}"
    );

    handle.shutdown().await;
    let _ = failed_shutdown.send(());
    let _ = recovery_shutdown.send(());
    std::env::remove_var(AUTH_ENV);
    drop(home_guard);
}

const C8BC12F_AUTH_ENV: &str = "ISSUE_C8BC12F_CHAT_KEY";
const C8BC12F_CLIENT_MODEL: &str = "c8bc12f-client";
const C8BC12F_WIRE_MODEL: &str = "c8bc12f-wire";
const C8BC12F_PROVIDER_A: &str = "c8bc12f_a";
const C8BC12F_PROVIDER_B: &str = "c8bc12f_b";

#[derive(Clone, Copy, Debug)]
enum C8bc12fResponseVariant {
    Completed,
    MalformedJson,
}

#[derive(Debug)]
struct C8bc12fProviderCapture {
    provider: &'static str,
    body: Value,
}

#[derive(Debug)]
struct C8bc12fClientCapture {
    status: Option<StatusCode>,
    bytes: Vec<u8>,
    send_error: Option<String>,
    read_error: Option<String>,
}

struct C8bc12fCleanupGuard {
    provider_tasks: Vec<tokio::task::AbortHandle>,
}

impl C8bc12fCleanupGuard {
    fn new(provider_tasks: Vec<tokio::task::AbortHandle>) -> Self {
        std::env::set_var(C8BC12F_AUTH_ENV, "c8bc12f-controlled-key");
        Self { provider_tasks }
    }
}

impl Drop for C8bc12fCleanupGuard {
    fn drop(&mut self) {
        for task in &self.provider_tasks {
            task.abort();
        }
        std::env::remove_var(C8BC12F_AUTH_ENV);
    }
}

impl C8bc12fClientCapture {
    fn body_lossy(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }

    fn transport_failed(&self) -> bool {
        self.send_error.is_some() || self.read_error.is_some()
    }

    fn diagnostic(&self) -> String {
        format!(
            "status={:?} bytes={} body={} send_error={:?} read_error={:?}",
            self.status,
            self.bytes.len(),
            self.body_lossy(),
            self.send_error,
            self.read_error
        )
    }
}

#[derive(Clone)]
struct C8bc12fProviderState {
    provider: &'static str,
    failure_status: Option<StatusCode>,
    variant: Option<C8bc12fResponseVariant>,
    captures: mpsc::UnboundedSender<C8bc12fProviderCapture>,
}

async fn c8bc12f_provider(
    State(state): State<C8bc12fProviderState>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(C8bc12fProviderCapture {
            provider: state.provider,
            body,
        })
        .expect("controlled provider capture channel must remain open");

    if let Some(status) = state.failure_status {
        return Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(
                format!(
                    r#"{{"error":{{"type":"private_http_{}","message":"private A sentinel must not reach the client"}}}}"#,
                    status.as_u16()
                ),
            ))
            .unwrap();
    }

    let body = match state
        .variant
        .expect("a non-failure controlled provider must declare a response variant")
    {
        C8bc12fResponseVariant::Completed => serde_json::to_string(&json!({
            "id": "chatcmpl_c8bc12f_completed",
            "object": "chat.completion",
            "created": 1,
            "model": C8BC12F_WIRE_MODEL,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "C8BC12F_B_COMPLETED"
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 5,
                "completion_tokens": 3,
                "total_tokens": 8
            }
        }))
        .unwrap(),
        C8bc12fResponseVariant::MalformedJson => "{\"id\":\"broken\"".to_string(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap()
}

async fn start_c8bc12f_provider(
    provider: &'static str,
    variant: Option<C8bc12fResponseVariant>,
    captures: mpsc::UnboundedSender<C8bc12fProviderCapture>,
) -> (u16, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let failure_status = variant.is_none().then_some(StatusCode::TOO_MANY_REQUESTS);
    start_controlled_c8bc12f_provider(provider, failure_status, variant, captures).await
}

async fn start_controlled_c8bc12f_provider(
    provider: &'static str,
    failure_status: Option<StatusCode>,
    variant: Option<C8bc12fResponseVariant>,
    captures: mpsc::UnboundedSender<C8bc12fProviderCapture>,
) -> (u16, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let state = C8bc12fProviderState {
        provider,
        failure_status,
        variant,
        captures,
    };
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(c8bc12f_provider))
                .with_state(state),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        })
        .await
        .unwrap();
    });
    (port, shutdown, task)
}

fn c8bc12f_manifest(
    server_port: u16,
    provider_a_port: u16,
    provider_b_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    c8bc12f_manifest_with_provider_count(server_port, provider_a_port, provider_b_port, true)
}

fn c8bc12f_manifest_with_provider_count(
    server_port: u16,
    provider_a_port: u16,
    provider_b_port: u16,
    include_provider_b: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    assert!(
        declaration.contains(direct_binding),
        "fixture must expose the expected Responses Direct binding"
    );
    let declaration = declaration.replace(direct_binding, relay_binding);
    let execution = hub_v1_fixture::hub_v1_server_execution("c8bc12f");
    let provider_b = include_provider_b.then(|| {
        format!(
            r#"[providers.{provider_b}]
type = "openai_chat"
base_url = "http://127.0.0.1:{provider_b_port}/v1"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "b", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.{provider_b}.models.{wire_model}]
wire_name = "{wire_model}"
aliases = ["{client_model}"]
supports_streaming = true
capabilities = ["text"]
"#,
            provider_b = C8BC12F_PROVIDER_B,
            provider_b_port = provider_b_port,
            wire_model = C8BC12F_WIRE_MODEL,
            auth_env = C8BC12F_AUTH_ENV,
            client_model = C8BC12F_CLIENT_MODEL,
        )
    });
    let provider_b_target = include_provider_b.then(|| {
        format!(
            r#", {{ kind = "provider_model", provider = "{provider_b}", model = "{wire_model}", key = "b", priority = 1 }}"#,
            provider_b = C8BC12F_PROVIDER_B,
            wire_model = C8BC12F_WIRE_MODEL,
        )
    });
    let source = format!(
        r#"
version = 3
{declaration}
[servers.c8bc12f]
bind = "127.0.0.1"
port = {server_port}
routing_group = "c8bc12f"
endpoints = ["responses"]
{execution}
[providers.{provider_a}]
type = "openai_chat"
base_url = "http://127.0.0.1:{provider_a_port}/v1"
default_model = "{wire_model}"
auth = {{ type = "api_key", entries = [{{ alias = "a", env = "{auth_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.{provider_a}.models.{wire_model}]
wire_name = "{wire_model}"
aliases = ["{client_model}"]
supports_streaming = true
capabilities = ["text"]
{provider_b}
[route_groups.c8bc12f.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "{provider_a}", model = "{wire_model}", key = "a", priority = 2 }}{provider_b_target}
]
[debug]
log_console = false
snapshots = true
"#,
        declaration = declaration,
        execution = execution,
        provider_a = C8BC12F_PROVIDER_A,
        provider_b = provider_b.unwrap_or_default(),
        provider_b_target = provider_b_target.unwrap_or_default(),
        wire_model = C8BC12F_WIRE_MODEL,
        client_model = C8BC12F_CLIENT_MODEL,
        auth_env = C8BC12F_AUTH_ENV,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn assert_c8bc12f_responses_relay_variant(variant: C8bc12fResponseVariant) {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (provider_a_port, shutdown_a, task_a) =
        start_c8bc12f_provider(C8BC12F_PROVIDER_A, None, captures_tx.clone()).await;
    let (provider_b_port, shutdown_b, task_b) =
        start_c8bc12f_provider(C8BC12F_PROVIDER_B, Some(variant), captures_tx).await;
    let _cleanup = C8bc12fCleanupGuard::new(vec![task_a.abort_handle(), task_b.abort_handle()]);
    let server_port = test_ports::free_port();
    let handle: V3ServerAggregateHandle = spawn_v3_server_aggregate(c8bc12f_manifest(
        server_port,
        provider_a_port,
        provider_b_port,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let request = json!({
        "model": C8BC12F_CLIENT_MODEL,
        "input": "c8bc12f controlled Responses Relay request",
        "stream": true
    });
    let client_result = client
        .post(format!("{base}/v1/responses"))
        .json(&request)
        .send()
        .await;
    let client_capture = match client_result {
        Err(error) => C8bc12fClientCapture {
            status: None,
            bytes: Vec::new(),
            send_error: Some(error.to_string()),
            read_error: None,
        },
        Ok(mut response) => {
            let status = Some(response.status());
            let mut bytes = Vec::new();
            let mut read_error = None;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(error) => {
                        read_error = Some(error.to_string());
                        break;
                    }
                }
            }
            C8bc12fClientCapture {
                status,
                bytes,
                send_error: None,
                read_error,
            }
        }
    };
    let client_wire = client_capture.diagnostic();

    let mut captures = Vec::new();
    for _ in 0..2 {
        captures.push(
            tokio::time::timeout(Duration::from_secs(5), captures_rx.recv())
                .await
                .expect("both provider attempts must reach the controlled upstream")
                .expect("controlled provider capture channel must remain open"),
        );
    }
    assert_eq!(
        captures.iter().map(|capture| capture.provider).collect::<Vec<_>>(),
        [C8BC12F_PROVIDER_A, C8BC12F_PROVIDER_B],
        "the public Responses Relay request must try the 429 candidate before the HTTP 200 candidate"
    );
    for capture in &captures {
        assert_eq!(
            capture.body["model"], C8BC12F_WIRE_MODEL,
            "provider requests must use the configured wire model: {capture:?}"
        );
    }

    let records_path = request_records_path(&home, server_port);
    let deadline = Instant::now() + Duration::from_secs(20);
    let rows = loop {
        let rows = read_rows_strict(&records_path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };
    let terminal_rows = rows
        .iter()
        .filter(|row| is_terminal(row))
        .collect::<Vec<_>>();
    let a_attempt_rows = rows
        .iter()
        .filter(|row| {
            row["event_type"] == "request.provider_attempt_failed"
                && row["meta"]["provider_id"] == C8BC12F_PROVIDER_A
        })
        .collect::<Vec<_>>();
    let b_attempt_rows = rows
        .iter()
        .filter(|row| {
            row["event_type"] == "request.provider_attempt_failed"
                && row["meta"]["provider_id"] == C8BC12F_PROVIDER_B
        })
        .collect::<Vec<_>>();
    eprintln!(
        "[issuec8bc12f] variant={variant:?} client={client_wire} a_attempts={a_attempt_rows:#?} b_attempts={b_attempt_rows:#?} rows={:#?}",
        rows
    );
    assert_eq!(
        terminal_rows.len(),
        1,
        "the Responses Relay request must write exactly one terminal row: {rows:#?}"
    );
    assert!(
        rows.iter()
            .any(|row| row["meta"]["execution_mode"] == "relay"),
        "the public /v1/responses request must actually enter Relay mode: {rows:#?}"
    );
    assert_eq!(
        a_attempt_rows.len(),
        1,
        "candidate A must have exactly one failed attempt row: {rows:#?}"
    );
    assert_eq!(
        a_attempt_rows[0]["meta"]["provider_status"], 429,
        "candidate A's real HTTP 429 must remain an independent attempt row: {rows:#?}"
    );
    assert!(
        !client_wire.contains("c8bc12f_private_rate_limit")
            && !client_wire.contains("private A sentinel"),
        "candidate A's private provider error must not reach the client: {client_wire}"
    );

    match variant {
        C8bc12fResponseVariant::Completed => {
            assert!(
                b_attempt_rows.is_empty(),
                "a completed B business response must not create a failed attempt row: {rows:#?}"
            );
            assert_eq!(
                client_capture.status,
                Some(StatusCode::OK),
                "the completed business response must reach the client over HTTP 200: {client_wire}"
            );
            assert!(!client_capture.transport_failed());
            assert!(
                client_wire.contains("C8BC12F_B_COMPLETED"),
                "B's completed business content must reach the client: {client_wire}"
            );
            assert!(
                client_wire.contains("response.completed"),
                "B's completed terminal must reach the client: {client_wire}"
            );
            assert_eq!(
                terminal_rows[0]["event_type"], "request.completed",
                "a completed B business response must produce a completed request row: {rows:#?}"
            );
            assert_eq!(terminal_rows[0]["result"], "success");
        }
        C8bc12fResponseVariant::MalformedJson => {
            assert_eq!(
                b_attempt_rows.len(),
                1,
                "candidate B must have exactly one failed attempt row: {rows:#?}"
            );
            let b_attempt = b_attempt_rows[0];
            assert_eq!(
                b_attempt["meta"]["provider_id"], C8BC12F_PROVIDER_B,
                "the malformed response must remain attributed to candidate B: {rows:#?}"
            );
            assert_eq!(
                b_attempt["meta"]["provider_status"], 200,
                "candidate B's failed attempt must preserve its real HTTP 200 status: {rows:#?}"
            );
            assert_eq!(
                b_attempt["meta"]["observed_error"]["external_error_status"], 200,
                "candidate B's typed source must retain the real HTTP 200 status: {rows:#?}"
            );
            assert_eq!(
                b_attempt["meta"]["observed_error"]["external_error_code"],
                "provider_response_body_error",
                "candidate B's typed cause must be its body decode failure, not candidate A's 429: {rows:#?}"
            );
            assert_eq!(
                b_attempt["meta"]["error_category"], "provider_response_body_error",
                "candidate B's failed attempt must use its own error category: {rows:#?}"
            );
            assert!(
                b_attempt["meta"]["error_detail"]
                    .as_str()
                    .is_some_and(|detail| detail.contains("decode failed")),
                "candidate B's failed attempt must preserve the decode failure: {rows:#?}"
            );
            let b_attempt_text = b_attempt.to_string();
            assert!(
                !b_attempt_text.contains("rate_limit")
                    && !b_attempt_text.contains("private A sentinel"),
                "candidate B's failed attempt must not inherit candidate A's rate-limit cause: {rows:#?}"
            );
            assert!(
                client_capture.transport_failed(),
                "HTTP 200 response-processing failure must end the client transport detectably: {client_wire}"
            );
            assert!(
                !client_wire.contains("response.completed")
                    && !client_wire.contains("event: error")
                    && !client_wire.contains("provider_response_body_error"),
                "the failed client transport must not receive fabricated success or an error payload: {client_wire}"
            );
            assert_eq!(
                terminal_rows[0]["event_type"], "request.failed",
                "HTTP 200 response-processing failure must write one failed terminal: {rows:#?}"
            );
            assert_eq!(
                terminal_rows[0]["result"], "error",
                "the failed terminal must not be counted as success: {rows:#?}"
            );
            assert_eq!(
                terminal_rows[0]["meta"]["provider_id"], C8BC12F_PROVIDER_B,
                "the final failed terminal must belong to candidate B: {rows:#?}"
            );
            assert_eq!(
                terminal_rows[0]["meta"]["provider_status"], 200,
                "the failed terminal must preserve B's real HTTP 200 upstream status: {rows:#?}"
            );
            assert_eq!(
                terminal_rows[0]["meta"]["observed_error"]["external_error_status"], 200,
                "the final typed source must preserve B's real HTTP 200 upstream status: {rows:#?}"
            );
            assert_eq!(
                terminal_rows[0]["meta"]["error_category"], "provider_response_body_error",
                "the failed terminal must use the typed HTTP 200 body-processing cause: {rows:#?}"
            );
            assert!(
                terminal_rows[0]["meta"]["error_detail"]
                    .as_str()
                    .is_some_and(|detail| detail.contains("decode failed")),
                "the failed terminal must preserve the decode cause: {rows:#?}"
            );
            let error_chain = terminal_rows[0]["meta"]["observed_error"]["chain"]
                .as_array()
                .expect("the failed terminal must carry an Error chain")
                .iter()
                .map(|entry| entry["node"].as_str().unwrap_or_default())
                .collect::<Vec<_>>();
            assert_eq!(
                error_chain,
                [
                    "V3Error01SourceRaised",
                    "V3Error02Classified",
                    "V3Error03TargetLocalAction",
                    "V3Error04TargetExhaustionDecision",
                    "V3Error05ExecutionDecision",
                    "V3Error06ClientProjected",
                ],
                "the failed terminal must preserve the complete typed Error01-06 chain: {rows:#?}"
            );
        }
    }

    assert!(handle.shutdown().await.is_empty());
    let _ = shutdown_a.send(());
    let _ = shutdown_b.send(());
    tokio::time::timeout(Duration::from_secs(10), task_a)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), task_b)
        .await
        .unwrap()
        .unwrap();
    drop(home_guard);
}

async fn assert_dd1de7e_responses_relay_provider_http_400(recovers: bool) {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME").map(PathBuf::from).unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (provider_a_port, shutdown_a, task_a) = start_controlled_c8bc12f_provider(
        C8BC12F_PROVIDER_A,
        Some(StatusCode::BAD_REQUEST),
        None,
        captures_tx.clone(),
    )
    .await;
    let (provider_b_port, shutdown_b, task_b) = if recovers {
        let (port, shutdown, task) = start_controlled_c8bc12f_provider(
            C8BC12F_PROVIDER_B,
            None,
            Some(C8bc12fResponseVariant::Completed),
            captures_tx,
        )
        .await;
        (Some(port), Some(shutdown), Some(task))
    } else {
        (None, None, None)
    };
    let mut provider_tasks = vec![task_a.abort_handle()];
    if let Some(task) = task_b.as_ref() {
        provider_tasks.push(task.abort_handle());
    }
    let _cleanup = C8bc12fCleanupGuard::new(provider_tasks);
    let server_port = test_ports::free_port();
    let handle = spawn_v3_server_aggregate(c8bc12f_manifest_with_provider_count(
        server_port,
        provider_a_port,
        provider_b_port.unwrap_or(provider_a_port),
        recovers,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap();
    let request = json!({
        "model": C8BC12F_CLIENT_MODEL,
        "input": "dd1de7e controlled Responses Relay provider HTTP 400 request",
        "stream": true
    });
    let client_capture = match client
        .post(format!("{base}/v1/responses"))
        .json(&request)
        .send()
        .await
    {
        Err(error) => C8bc12fClientCapture {
            status: None,
            bytes: Vec::new(),
            send_error: Some(error.to_string()),
            read_error: None,
        },
        Ok(mut response) => {
            let status = Some(response.status());
            let mut bytes = Vec::new();
            let mut read_error = None;
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(error) => {
                        read_error = Some(error.to_string());
                        break;
                    }
                }
            }
            C8bc12fClientCapture {
                status,
                bytes,
                send_error: None,
                read_error,
            }
        }
    };
    let client_wire = client_capture.diagnostic();

    let expected_attempts = if recovers { 2 } else { 1 };
    let mut captures = Vec::new();
    for _ in 0..expected_attempts {
        captures.push(
            tokio::time::timeout(Duration::from_secs(5), captures_rx.recv())
                .await
                .expect("every expected provider attempt must reach its controlled upstream")
                .expect("controlled provider capture channel must remain open"),
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), captures_rx.recv())
            .await
            .is_err(),
        "the failed identity must not be retried and no unexpected provider may be attempted"
    );

    let mut expected_providers = vec![C8BC12F_PROVIDER_A];
    if recovers {
        expected_providers.push(C8BC12F_PROVIDER_B);
    }
    assert_eq!(
        captures
            .iter()
            .map(|capture| capture.provider)
            .collect::<Vec<_>>(),
        expected_providers,
        "the public Responses Relay request must try each declared provider once in order"
    );
    for capture in &captures {
        assert_eq!(
            capture.body["model"], C8BC12F_WIRE_MODEL,
            "provider requests must use the configured wire model: {capture:?}"
        );
    }

    let records_path = request_records_path(&home, server_port);
    let deadline = Instant::now() + Duration::from_secs(20);
    let rows = loop {
        let rows = read_rows_strict(&records_path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };
    let terminal_rows = rows
        .iter()
        .filter(|row| is_terminal(row))
        .collect::<Vec<_>>();
    let provider_a_attempts = rows
        .iter()
        .filter(|row| {
            row["event_type"] == "request.provider_attempt_failed"
                && row["meta"]["provider_id"] == C8BC12F_PROVIDER_A
        })
        .collect::<Vec<_>>();
    eprintln!(
        "[issuedd1de7e] recovers={recovers} client={client_wire} provider_a_attempts={provider_a_attempts:#?} rows={rows:#?}"
    );
    assert_eq!(
        terminal_rows.len(),
        1,
        "the Responses Relay request must write exactly one terminal row: {rows:#?}"
    );
    assert!(
        rows.iter().any(|row| {
            row["event_type"] == "request.route_selected"
                && row["meta"]["execution_mode"] == "relay"
        }),
        "the public /v1/responses request must actually enter Relay mode: {rows:#?}"
    );
    assert_eq!(
        provider_a_attempts.len(),
        1,
        "the HTTP 400 identity must have exactly one failed attempt row: {rows:#?}"
    );
    assert_eq!(
        provider_a_attempts[0]["meta"]["provider_status"], 400,
        "the first provider's real HTTP 400 must remain an attempt fact: {rows:#?}"
    );
    if recovers {
        assert!(
            !client_wire.contains("private A sentinel")
                && !client_wire.contains("private_http_400"),
            "the non-final provider 400 body must not reach the client: {client_wire}"
        );
        assert_eq!(
            client_capture.status,
            Some(StatusCode::OK),
            "the healthy eligible sibling must complete the public request: {client_wire}"
        );
        assert!(!client_capture.transport_failed());
        assert!(
            client_wire.contains("C8BC12F_B_COMPLETED"),
            "the healthy sibling's business response must reach the client: {client_wire}"
        );
        assert!(
            client_wire.contains("response.completed"),
            "the healthy sibling must deliver its real protocol terminal: {client_wire}"
        );
        assert_eq!(
            terminal_rows[0]["event_type"], "request.completed",
            "a recovered request must not be closed as failed: {rows:#?}"
        );
        assert_eq!(terminal_rows[0]["result"], "success");
    } else {
        assert!(
            client_capture.transport_failed(),
            "exhausted Provider HTTP 400 on SSE stream must terminate transport cleanly without projecting error body: {client_wire}"
        );
        assert!(
            !client_wire.contains("private A sentinel")
                && !client_wire.contains("private_http_400"),
            "the exhausted Provider error body must not leak to the client: {client_wire}"
        );
        assert!(
            !client_wire.contains("response.completed") && !client_wire.contains("network_error"),
            "the exhausted Provider error must not fabricate success or a proxy error: {client_wire}"
        );
        assert_eq!(
            terminal_rows[0]["event_type"], "request.failed",
            "provider exhaustion must write one failed terminal: {rows:#?}"
        );
        assert_eq!(
            terminal_rows[0]["meta"]["provider_status"], 400,
            "the terminal row must preserve the real provider HTTP 400: {rows:#?}"
        );
        assert_eq!(
            terminal_rows[0]["meta"]["error_category"], "http_400",
            "the terminal row must record the real provider 400 category rather than network_error: {rows:#?}"
        );
        assert_eq!(
            terminal_rows[0]["meta"]["observed_error"]["external_error_status"], 400,
            "the typed Error01 source must preserve the provider 400: {rows:#?}"
        );
        assert_eq!(
            terminal_rows[0]["meta"]["provider"], "c8bc12f_a:default:a:c8bc12f-wire",
            "the terminal row must preserve the exact failed provider identity: {rows:#?}"
        );
        assert_eq!(
            terminal_rows[0]["meta"]["provider_id"], C8BC12F_PROVIDER_A,
            "the terminal row must preserve the failed provider id: {rows:#?}"
        );
        assert_eq!(
            terminal_rows[0]["meta"]["auth_alias"], "a",
            "the terminal row must preserve the failed auth alias: {rows:#?}"
        );
        assert_eq!(
            terminal_rows[0]["meta"]["wire_model"], C8BC12F_WIRE_MODEL,
            "the terminal row must preserve the failed wire model: {rows:#?}"
        );
        assert!(
            terminal_rows[0]["meta"]["observed_error"]["next_provider_key"].is_null(),
            "the final failed row must not retain the failed identity as the next provider: {rows:#?}"
        );
        let error_chain = terminal_rows[0]["meta"]["observed_error"]["chain"]
            .as_array()
            .expect("the failed terminal must carry an Error chain")
            .iter()
            .map(|entry| entry["node"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            error_chain,
            [
                "V3Error01SourceRaised",
                "V3Error02Classified",
                "V3Error03TargetLocalAction",
                "V3Error04TargetExhaustionDecision",
                "V3Error05ExecutionDecision",
                "V3Error06ClientProjected",
            ],
            "the failed terminal must preserve the complete typed Error01-06 chain: {rows:#?}"
        );
    }

    handle.shutdown().await;
    let _ = shutdown_a.send(());
    if let Some(shutdown) = shutdown_b {
        let _ = shutdown.send(());
    }
    tokio::time::timeout(Duration::from_secs(10), task_a)
        .await
        .unwrap()
        .unwrap();
    if let Some(task) = task_b {
        tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap();
    }
    drop(home_guard);
}

#[tokio::test]
async fn issue23fe689_openai_chat_direct_provider_terminal_ledger_terminal() {
    assert_entry_writes_one_failed_terminal(Entry::Chat, Mode::Direct).await;
}

#[tokio::test]
async fn issue23fe689_openai_chat_relay_provider_terminal_ledger_terminal() {
    assert_entry_writes_one_failed_terminal(Entry::Chat, Mode::Relay).await;
}

#[tokio::test]
async fn issue23fe689_anthropic_direct_provider_terminal_ledger_terminal() {
    assert_entry_writes_one_failed_terminal(Entry::Anthropic, Mode::Direct).await;
}

#[tokio::test]
async fn issue23fe689_anthropic_relay_provider_terminal_ledger_terminal() {
    assert_entry_writes_one_failed_terminal(Entry::Anthropic, Mode::Relay).await;
}

#[tokio::test]
async fn issue23fe689_gemini_direct_provider_terminal_ledger_terminal() {
    assert_entry_writes_one_failed_terminal(Entry::Gemini, Mode::Direct).await;
}

#[tokio::test]
async fn issue23fe689_gemini_relay_provider_terminal_ledger_terminal() {
    assert_entry_writes_one_failed_terminal(Entry::Gemini, Mode::Relay).await;
}

#[tokio::test]
async fn issue23fe689_recovered_candidate_is_not_closed_early() {
    assert_failed_candidate_recovers().await;
}

#[tokio::test]
async fn issuec8bc12f_responses_relay_http200_completed_business_terminal() {
    assert_c8bc12f_responses_relay_variant(C8bc12fResponseVariant::Completed).await;
}

#[tokio::test]
async fn issuec8bc12f_responses_relay_http200_malformed_processing_failure_terminal() {
    assert_c8bc12f_responses_relay_variant(C8bc12fResponseVariant::MalformedJson).await;
}

#[tokio::test]
async fn issuedd1de7e_responses_relay_provider_http_400_terminal_provenance() {
    assert_dd1de7e_responses_relay_provider_http_400(false).await;
}

#[tokio::test]
async fn issuedd1de7e_responses_relay_provider_http_400_recovers_eligible_sibling() {
    assert_dd1de7e_responses_relay_provider_http_400(true).await;
}
