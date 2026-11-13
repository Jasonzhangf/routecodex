//! Public-entry timing regressions for Direct bounded refill.
//!
//! Command:
//! `node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test refill_timing_public -- --nocapture --test-threads=1`
//!
//! The upstream delay is part of the controlled behavior: each provider round
//! has a distinct measured interval, so the public request ledger must expose
//! the sum of both completed rounds without counting either round twice.

use axum::{
    body::Body,
    extract::State,
    http::{header::CONTENT_TYPE, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::time::sleep;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

#[path = "support/fa22072_test_home.rs"]
mod test_home;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "REFILL_TIMING_PUBLIC_KEY";
const CLIENT_MODEL: &str = "refill-timing-model";
const FIRST_TEXT: &str = "REFILL_TIMING_FIRST_ROUND";
const SECOND_TEXT: &str = "REFILL_TIMING_SECOND_ROUND";
const SINGLE_TEXT: &str = "REFILL_TIMING_SOURCE_SUMMARY";

const FIRST_ROUND_DELAY_MS: u64 = 1_500;
const SECOND_ROUND_DELAY_MS: u64 = 500;
const SINGLE_ROUND_DELAY_MS: u64 = 900;
const TIMING_TOLERANCE_MS: u64 = 500;

const TWO_ROUND_MIN_EXTERNAL_MS: u64 =
    FIRST_ROUND_DELAY_MS + SECOND_ROUND_DELAY_MS - TIMING_TOLERANCE_MS;
const TWO_ROUND_MAX_EXTERNAL_MS: u64 =
    FIRST_ROUND_DELAY_MS + SECOND_ROUND_DELAY_MS + TIMING_TOLERANCE_MS;
const SINGLE_ROUND_MIN_EXTERNAL_MS: u64 = SINGLE_ROUND_DELAY_MS - TIMING_TOLERANCE_MS;
const SINGLE_ROUND_MAX_EXTERNAL_MS: u64 = SINGLE_ROUND_DELAY_MS + TIMING_TOLERANCE_MS;

#[derive(Clone, Copy, Debug)]
enum Scenario {
    Refill,
    SourceSummary,
}

impl Scenario {
    fn delay_ms(self, attempt: usize) -> u64 {
        match self {
            Self::Refill if attempt == 0 => FIRST_ROUND_DELAY_MS,
            Self::Refill => SECOND_ROUND_DELAY_MS,
            Self::SourceSummary => SINGLE_ROUND_DELAY_MS,
        }
    }

    fn response(self, attempt: usize) -> Value {
        match self {
            Self::Refill if attempt == 0 => text_response(FIRST_TEXT),
            Self::Refill => text_response(SECOND_TEXT),
            Self::SourceSummary => source_summary_response(),
        }
    }
}

#[derive(Clone, Debug)]
struct Capture {
    attempt: usize,
    body: Value,
}

struct ProviderState {
    scenario: Scenario,
    content_type: &'static str,
    calls: AtomicUsize,
    captures: Mutex<Vec<Capture>>,
}

async fn controlled_upstream(
    State(state): State<Arc<ProviderState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    let attempt = state.calls.fetch_add(1, Ordering::SeqCst);
    state
        .captures
        .lock()
        .expect("provider capture lock")
        .push(Capture { attempt, body });

    sleep(Duration::from_millis(state.scenario.delay_ms(attempt))).await;

    let response = state.scenario.response(attempt);
    let wire = if state.content_type == "text/event-stream" {
        response_sse(&response)
    } else {
        response.to_string()
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", state.content_type)
        .body(Body::from(wire))
        .unwrap()
}

struct Entry {
    endpoint: String,
    handle: routecodex_v3_server::V3ServerAggregateHandle,
    provider: Arc<ProviderState>,
    server_port: u16,
    peer_shutdown: tokio::sync::oneshot::Sender<()>,
}

struct AuthEnvGuard(Option<OsString>);

impl AuthEnvGuard {
    fn install() -> Self {
        let previous = std::env::var_os(AUTH_ENV);
        std::env::set_var(AUTH_ENV, "refill-timing-public-secret");
        Self(previous)
    }
}

impl Drop for AuthEnvGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(value) => std::env::set_var(AUTH_ENV, value),
            None => std::env::remove_var(AUTH_ENV),
        }
    }
}

async fn start_entry(client_stream: bool, scenario: Scenario) -> Entry {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("controlled provider listener");
    let upstream_port = upstream
        .local_addr()
        .expect("controlled provider address")
        .port();
    let (peer_shutdown_tx, peer_shutdown_rx) = tokio::sync::oneshot::channel();
    let provider = Arc::new(ProviderState {
        scenario,
        content_type: if client_stream {
            "text/event-stream"
        } else {
            "application/json"
        },
        calls: AtomicUsize::new(0),
        captures: Mutex::new(Vec::new()),
    });
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .with_state(Arc::clone(&provider));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = peer_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(None);
    let server_port = test_ports::free_port();
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let source = format!(
        r#"
version = 3
{declaration}

[servers.owned]
bind = "127.0.0.1"
port = {server_port}
routing_group = "owned"
endpoints = ["responses"]

[servers.owned.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.timing]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "{CLIENT_MODEL}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
responses = {{ process = "direct", streaming = "always" }}

[providers.timing.models."{CLIENT_MODEL}"]
wire_name = "{CLIENT_MODEL}"
capabilities = ["text"]
supports_streaming = true
max_context_tokens = 128000

[route_groups.owned.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "timing", model = "{CLIENT_MODEL}", key = "key", priority = 1 }}]
"#
    );
    let manifest =
        compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap();
    let handle = spawn_v3_server_aggregate(manifest)
        .await
        .expect("aggregate server fixture");
    let listener = handle.listeners[0].addr;
    Entry {
        endpoint: format!("http://{listener}/v1/responses"),
        handle,
        provider,
        server_port,
        peer_shutdown: peer_shutdown_tx,
    }
}

#[derive(Debug)]
struct Outcome {
    body: String,
    captures: Vec<Capture>,
    terminal: Value,
}

async fn run_public_case(label: &str, client_stream: bool, scenario: Scenario) -> Outcome {
    let (home_guard, _lock) = TEST_LOCK.lock().await;
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .expect("fixture home");
    let _auth_guard = AuthEnvGuard::install();
    let entry = start_entry(client_stream, scenario).await;

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("public client");
    let response = client
        .post(&entry.endpoint)
        .json(&json!({
            "model": CLIENT_MODEL,
            "input": "bounded Direct refill timing public case",
            "stream": client_stream
        }))
        .send()
        .await
        .unwrap_or_else(|error| panic!("{label}: public request failed: {error}"));
    assert_eq!(response.status(), StatusCode::OK, "{label}: public status");
    assert!(
        response.headers().get(CONTENT_TYPE).is_some(),
        "{label}: public content type must be present"
    );
    let body = response
        .text()
        .await
        .unwrap_or_else(|error| panic!("{label}: public body failed: {error}"));

    let records_path = request_records_path(&home, entry.server_port);
    let rows = wait_terminal(&records_path, Duration::from_secs(15)).await;
    let captures = entry
        .provider
        .captures
        .lock()
        .expect("provider capture lock")
        .clone();
    let terminal = terminal_row(&rows, label).clone();

    entry.handle.shutdown().await;
    let _ = entry.peer_shutdown.send(());
    drop(home_guard);

    Outcome {
        body,
        captures,
        terminal,
    }
}

fn text_response(text: &str) -> Value {
    json!({
        "id": "resp_refill_timing",
        "object": "response",
        "status": "completed",
        "model": CLIENT_MODEL,
        "output": [{
            "id": "msg_refill_timing",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{
                "type": "output_text",
                "text": text,
                "annotations": []
            }]
        }]
    })
}

fn source_summary_response() -> Value {
    json!({
        "id": "resp_refill_timing_summary",
        "object": "response",
        "status": "completed",
        "model": CLIENT_MODEL,
        "output": [
            {
                "id": "rs_refill_timing_summary",
                "type": "reasoning",
                "summary": [{"type": "summary_text", "text": "source summary stops refill"}]
            },
            {
                "id": "msg_refill_timing_summary",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{
                    "type": "output_text",
                    "text": SINGLE_TEXT,
                    "annotations": []
                }]
            }
        ]
    })
}

fn sse_event(event: &str, response: &Value) -> String {
    format!(
        "event: {event}\ndata: {}\n\n",
        json!({"type": event, "response": response})
    )
}

fn response_sse(response: &Value) -> String {
    sse_event("response.completed", response)
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

async fn wait_terminal(path: &std::path::Path, budget: Duration) -> Vec<Value> {
    let deadline = Instant::now() + budget;
    loop {
        let rows = read_rows(path);
        if rows.iter().any(is_terminal) || Instant::now() >= deadline {
            return rows;
        }
        sleep(Duration::from_millis(50)).await;
    }
}

fn terminal_row<'a>(rows: &'a [Value], label: &str) -> &'a Value {
    let terminals: Vec<&Value> = rows.iter().filter(|row| is_terminal(row)).collect();
    assert_eq!(
        terminals.len(),
        1,
        "{label}: exactly one terminal ledger row is required: {rows:#?}"
    );
    assert_eq!(
        terminals[0]["event_type"], "request.completed",
        "{label}: controlled business response must complete"
    );
    terminals[0]
}

fn assert_round_receipts(label: &str, captures: &[Capture], expected: usize) {
    assert_eq!(
        captures.len(),
        expected,
        "{label}: actual provider round receipts: {captures:#?}"
    );
    for (index, capture) in captures.iter().enumerate() {
        assert_eq!(
            capture.attempt, index,
            "{label}: provider receipts must preserve round order: {captures:#?}"
        );
    }
    if expected == 2 {
        let continuation = captures[1]
            .body
            .get("input")
            .map(|input| input.to_string())
            .unwrap_or_default();
        assert!(
            continuation.contains(FIRST_TEXT),
            "{label}: refill continuation must replay round one: {}",
            captures[1].body
        );
    }
}

fn assert_terminal_content(label: &str, outcome: &Outcome, client_stream: bool, texts: &[&str]) {
    if client_stream {
        let events: Vec<Value> = outcome
            .body
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim))
            .filter(|data| !data.is_empty() && *data != "[DONE]")
            .map(|data| serde_json::from_str(data).expect("valid SSE JSON"))
            .collect();
        let completed: Vec<&Value> = events
            .iter()
            .filter(|event| event["type"] == "response.completed")
            .collect();
        assert_eq!(
            completed.len(),
            1,
            "{label}: refill must deliver one final SSE terminal: {events:#?}"
        );
        let terminal = completed[0]["response"].to_string();
        for text in texts {
            assert!(
                terminal.contains(text),
                "{label}: terminal response is missing {text}: {terminal}"
            );
        }
        return;
    }

    let delivered: Value = serde_json::from_str(&outcome.body)
        .unwrap_or_else(|error| panic!("{label}: invalid JSON body ({error}): {outcome:?}"));
    assert_eq!(
        delivered["status"], "completed",
        "{label}: final JSON terminal must be completed: {delivered}"
    );
    let terminal = delivered["output"].to_string();
    for text in texts {
        assert!(
            terminal.contains(text),
            "{label}: final JSON output is missing {text}: {delivered}"
        );
    }
}

fn assert_request_timing(
    label: &str,
    terminal: &Value,
    min_external_ms: u64,
    max_external_ms: u64,
) {
    let internal_ms = terminal["timing_internal_ms"].as_u64().unwrap_or_else(|| {
        panic!("{label}: terminal timing is missing internal_ms: {terminal:#?}")
    });
    let external_ms = terminal["timing_external_ms"].as_u64().unwrap_or_else(|| {
        panic!("{label}: terminal timing is missing external_ms: {terminal:#?}")
    });
    let duration_ms = terminal["duration_ms"].as_u64().unwrap_or_else(|| {
        panic!("{label}: terminal timing is missing duration_ms: {terminal:#?}")
    });
    let runtime_total_ms = internal_ms.saturating_add(external_ms);

    assert!(
        external_ms >= min_external_ms,
        "{label}: external timing {external_ms}ms omits a completed provider round; expected at least {min_external_ms}ms"
    );
    assert!(
        external_ms <= max_external_ms,
        "{label}: external timing {external_ms}ms counts a provider round more than once; expected at most {max_external_ms}ms"
    );
    assert!(
        duration_ms >= runtime_total_ms,
        "{label}: internal+external={runtime_total_ms}ms exceeds public request duration={duration_ms}ms"
    );
}

#[tokio::test]
async fn direct_refill_json_timing_covers_both_rounds_once() {
    run_timing_case("json/two-round", false, Scenario::Refill).await;
}

#[tokio::test]
async fn direct_refill_sse_timing_covers_both_rounds_once() {
    run_timing_case("sse/two-round", true, Scenario::Refill).await;
}

#[tokio::test]
async fn direct_source_summary_json_timing_does_not_double_count() {
    run_timing_case("json/one-round", false, Scenario::SourceSummary).await;
}

#[tokio::test]
async fn direct_source_summary_sse_timing_does_not_double_count() {
    run_timing_case("sse/one-round", true, Scenario::SourceSummary).await;
}

async fn run_timing_case(label: &str, client_stream: bool, scenario: Scenario) {
    let outcome = run_public_case(label, client_stream, scenario).await;
    let expected_attempts = match scenario {
        Scenario::Refill => 2,
        Scenario::SourceSummary => 1,
    };
    assert_round_receipts(label, &outcome.captures, expected_attempts);
    // The upstream receipts above count business executions directly. Ledger
    // attempts are a separate projection and are not the timing oracle.

    let (texts, min_external_ms, max_external_ms) = match scenario {
        Scenario::Refill => (
            vec![FIRST_TEXT, SECOND_TEXT],
            TWO_ROUND_MIN_EXTERNAL_MS,
            TWO_ROUND_MAX_EXTERNAL_MS,
        ),
        Scenario::SourceSummary => (
            vec![SINGLE_TEXT],
            SINGLE_ROUND_MIN_EXTERNAL_MS,
            SINGLE_ROUND_MAX_EXTERNAL_MS,
        ),
    };
    assert_terminal_content(label, &outcome, client_stream, &texts);
    assert_request_timing(label, &outcome.terminal, min_external_ms, max_external_ms);
}
