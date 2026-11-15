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
//! - the client observes a transport break, not a provider status, error body,
//!   or fabricated success;
//! - the provider error payload never reaches the client.

use axum::{http::StatusCode, response::Response, routing::any, Router};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
    time::Duration,
};
use tokio::time::{sleep, Instant};

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
    assert!(
        response.is_err(),
        "provider exhaustion must end as a client transport break without an HTTP response: {response:?}"
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
        let rows = read_rows(&records_path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            break rows;
        }
        sleep(Duration::from_millis(50)).await;
    };

    eprintln!(
        "[issue23fe689] entry={:?} mode={mode:?} client=transport_break",
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
