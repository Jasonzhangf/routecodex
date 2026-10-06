//! REQ09 Relay mixed-failure public consumer.
//!
//! This consumer drives one real aggregate server through all four enabled
//! model-entry protocols (Responses, OpenAI Chat, Anthropic, Gemini) with the
//! entry protocol **explicitly bound to Relay** and a Relay-only execution
//! policy. For each entry the selected pool has exactly two candidates:
//!
//! 1. the first candidate reaches a real loopback upstream that answers a real
//!    HTTP 401, so the Relay attempt owner records an external HTTP witness;
//! 2. the second candidate fails locally because its auth environment variable
//!    is absent, so no network request can be sent to it.
//!
//! The pool then exhausts. The client transport must terminate incomplete with
//! no provider error envelope, the request-bound provider terminal must record
//! `no_response` (the earlier 401 must not be inherited as the local failure's
//! witness), and an independent healthy request must still complete on the same
//! aggregate.
//!
//! The router always appends the routing group's `default` pool as the floor
//! tier, so a healthy or cross-protocol `default` lets an exhausted request
//! recover through it. This fixture therefore runs four independent routing
//! groups in one aggregate, one per entry protocol, and each group's `default`
//! is the same local missing-auth candidate its match pool already failed on.
//! That is what makes the pool genuinely, completely exhausted. Each healthy
//! pool stays reachable because the independent healthy request selects it by
//! its own model before the floor tier is tried.
//!
//! The fixture is deliberately black-box: it uses public HTTP entries, real
//! loopback upstreams, the real config compiler, and one aggregate listener. It
//! never calls a private runtime helper or inspects private state.
//!
//! Coverage boundary: this consumer asserts the client transport break, the
//! request-bound provider terminal, and tool payload fidelity on the projected
//! provider wire. The internal per-node typed diagnostic evidence (the
//! `error.json` artifact and console event lines) is a separate concern owned by
//! another worker; this fixture neither asserts nor requires those artifacts.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, Mutex},
    time::timeout,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::hub_v1_test_declaration;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const FIRST_KEY_ENV: &str = "V3_REQ09_RELAY_MIXED_FIRST_KEY";
const MISSING_KEY_ENV: &str = "V3_REQ09_RELAY_MIXED_MISSING_KEY";
const HEALTHY_KEY_ENV: &str = "V3_REQ09_RELAY_MIXED_HEALTHY_KEY";

const UPSTREAM_401_MESSAGE: &str = "req09 relay mixed-failure upstream authentication rejected";

/// One aggregate listener per entry protocol. Each server owns its own routing
/// group so its explicit `default` pool can be that protocol's local
/// missing-auth candidate instead of a healthy or cross-protocol target.
const RESPONSES_SERVER_ID: &str = "req09_relay_mixed_responses";
const CHAT_SERVER_ID: &str = "req09_relay_mixed_chat";
const ANTHROPIC_SERVER_ID: &str = "req09_relay_mixed_anthropic";
const GEMINI_SERVER_ID: &str = "req09_relay_mixed_gemini";

const RESPONSES_EXHAUST_MARKER: &str = "REQ09_RELAY_MIXED_RESPONSES_EXHAUST";
const RESPONSES_HEALTHY_MARKER: &str = "REQ09_RELAY_MIXED_RESPONSES_HEALTHY";
const CHAT_EXHAUST_MARKER: &str = "REQ09_RELAY_MIXED_CHAT_EXHAUST";
const CHAT_HEALTHY_MARKER: &str = "REQ09_RELAY_MIXED_CHAT_HEALTHY";
const ANTHROPIC_EXHAUST_MARKER: &str = "REQ09_RELAY_MIXED_ANTHROPIC_EXHAUST";
const ANTHROPIC_HEALTHY_MARKER: &str = "REQ09_RELAY_MIXED_ANTHROPIC_HEALTHY";
const GEMINI_EXHAUST_MARKER: &str = "REQ09_RELAY_MIXED_GEMINI_EXHAUST";
const GEMINI_HEALTHY_MARKER: &str = "REQ09_RELAY_MIXED_GEMINI_HEALTHY";

const TOOL_SCHEMA_MARKER: &str = "REQ09_RELAY_MIXED_TOOL_SCHEMA";
const EXEC_ARGUMENT_MARKER: &str = "REQ09_RELAY_MIXED_EXEC_ARGUMENT_TAIL";
const PATCH_BODY_MARKER: &str = "REQ09_RELAY_MIXED_PATCH_BODY_TAIL";
const MCP_ARGUMENT_MARKER: &str = "REQ09_RELAY_MIXED_MCP_ARGUMENT_TAIL";
const EXEC_RESULT_MARKER: &str = "REQ09_RELAY_MIXED_EXEC_RESULT_TAIL";
const PATCH_RESULT_MARKER: &str = "REQ09_RELAY_MIXED_PATCH_RESULT_TAIL";
const MCP_RESULT_MARKER: &str = "REQ09_RELAY_MIXED_MCP_RESULT_TAIL";

const EXEC_CALL_ID: &str = "call_req09_relay_exec";
const PATCH_CALL_ID: &str = "call_req09_relay_patch";
const MCP_CALL_ID: &str = "call_req09_relay_mcp";

/// A `>= 4096`-byte exec command. The leading marker keeps the request-opaque
/// substring assertions working; the repeated tail makes truncation, reordering
/// or lossy re-escaping observable on the real provider wire.
fn req09_exec_command() -> String {
    format!(
        "{EXEC_ARGUMENT_MARKER}{}",
        "req09-exec-command-".repeat(256)
    )
}

fn req09_exec_arguments() -> String {
    serde_json::to_string(&json!({"cmd": req09_exec_command()}))
        .expect("exec arguments must serialize")
}

fn req09_exec_result() -> String {
    format!(
        "{EXEC_RESULT_MARKER}\nstdout:\n{}",
        "req09-exec-result-line\n".repeat(48)
    )
}

/// A complete multi-line free-form `apply_patch` payload. The Chat wire wraps
/// this opaque text as `{"input": "..."}` for the declared custom tool; the
/// assertion compares the whole JSON value, so the patch is never parsed.
fn req09_patch_input() -> String {
    let mut patch = String::from("*** Begin Patch\n");
    patch.push_str("*** Add File: req09_relay_tool_consumer.rs\n");
    for line in 0..24 {
        patch.push_str(&format!("+// req09 relay tool consumer line {line}\n"));
    }
    patch.push_str(&format!("+{PATCH_BODY_MARKER}\n"));
    patch.push_str("*** Update File: req09_relay_tool_consumer.rs\n");
    patch.push_str("@@\n");
    patch.push_str("-old opaque line\n");
    patch.push_str("+new opaque line\n");
    patch.push_str("*** End Patch\n");
    patch
}

fn req09_patch_result() -> String {
    format!(
        "Success. Updated the following files:\nA req09_relay_tool_consumer.rs\n{PATCH_RESULT_MARKER}\n"
    )
}

/// An opaque MCP argument string. It is not a business name or control fact; it
/// is compared as a JSON value so the proxy may neither parse nor rewrite it.
fn req09_mcp_argument() -> String {
    format!("{MCP_ARGUMENT_MARKER}{}", "req09-opaque-mcp-".repeat(256))
}

fn req09_mcp_arguments() -> String {
    serde_json::to_string(&json!({"opaque": req09_mcp_argument()}))
        .expect("mcp arguments must serialize")
}

fn req09_mcp_result() -> String {
    serde_json::to_string(&json!({
        "opaque": format!("{MCP_RESULT_MARKER}{}", "req09-mcp-result-".repeat(64))
    }))
    .expect("mcp result must serialize")
}

/// Isolated HOME so the aggregate server's sample store and diagnostics never
/// touch the operator's real `~/.rcc`.
struct TestHomeGuard {
    previous_home: Option<OsString>,
    previous_first_key: Option<OsString>,
    previous_missing_key: Option<OsString>,
    previous_healthy_key: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "routecodex-v3-req09-relay-mixed-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        let previous_home = std::env::var_os("HOME");
        let previous_first_key = std::env::var_os(FIRST_KEY_ENV);
        let previous_missing_key = std::env::var_os(MISSING_KEY_ENV);
        let previous_healthy_key = std::env::var_os(HEALTHY_KEY_ENV);
        std::env::set_var("HOME", &path);
        std::env::set_var(FIRST_KEY_ENV, "req09-relay-mixed-first-secret");
        std::env::remove_var(MISSING_KEY_ENV);
        std::env::set_var(HEALTHY_KEY_ENV, "req09-relay-mixed-healthy-secret");
        Self {
            previous_home,
            previous_first_key,
            previous_missing_key,
            previous_healthy_key,
            path,
        }
    }

    fn samples_root(&self) -> PathBuf {
        self.path.join(".rcc").join("codex-samples")
    }
}

impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous_home {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(previous) = &self.previous_first_key {
            std::env::set_var(FIRST_KEY_ENV, previous);
        } else {
            std::env::remove_var(FIRST_KEY_ENV);
        }
        if let Some(previous) = &self.previous_missing_key {
            std::env::set_var(MISSING_KEY_ENV, previous);
        } else {
            std::env::remove_var(MISSING_KEY_ENV);
        }
        if let Some(previous) = &self.previous_healthy_key {
            std::env::set_var(HEALTHY_KEY_ENV, previous);
        } else {
            std::env::remove_var(HEALTHY_KEY_ENV);
        }
        fs::remove_dir_all(&self.path).expect("remove this test's isolated HOME");
    }
}

#[derive(Clone)]
struct CaptureState {
    captures: mpsc::UnboundedSender<Value>,
    status: StatusCode,
    response_body: Arc<Value>,
}

async fn capture_and_respond(
    State(state): State<Arc<CaptureState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(body)
        .expect("capture receiver remains live");
    Response::builder()
        .status(state.status)
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::to_vec(&*state.response_body).expect("response fixture serializes"),
        ))
        .unwrap()
}

/// One real loopback provider upstream. It records every provider request so
/// "which upstream received the request" is the externally observable proof of
/// the selected candidate, and answers the configured status/body.
struct Upstream {
    base_url: String,
    captures: mpsc::UnboundedReceiver<Value>,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

async fn start_upstream(path: String, status: StatusCode, response_body: Value) -> Upstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route(&path, post(capture_and_respond))
        .with_state(Arc::new(CaptureState {
            captures: captures_tx,
            status,
            response_body: Arc::new(response_body),
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_rx.await.expect("upstream shutdown signal");
            })
            .await
            .unwrap();
    });
    Upstream {
        base_url: format!("http://{address}"),
        captures: captures_rx,
        shutdown: shutdown_tx,
        task,
    }
}

/// A fallback upstream used by the local missing-auth candidate. It must never
/// be reached; if it is, the capture proves the local failure leaked a network
/// request instead of failing in local transport construction.
async fn start_local_guard_upstream() -> Upstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captures_tx, captures_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .fallback(capture_and_respond)
        .with_state(Arc::new(CaptureState {
            captures: captures_tx,
            status: StatusCode::OK,
            response_body: Arc::new(json!({"unexpected": true})),
        }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                shutdown_rx.await.expect("local guard shutdown signal");
            })
            .await
            .unwrap();
    });
    Upstream {
        base_url: format!("http://{address}"),
        captures: captures_rx,
        shutdown: shutdown_tx,
        task,
    }
}

fn chat_response(text: &str) -> Value {
    json!({
        "id": "chatcmpl-req09-relay-mixed",
        "object": "chat.completion",
        "created": 0,
        "model": "req09-relay-mixed-wire",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    })
}

fn anthropic_response(text: &str) -> Value {
    json!({
        "id": "msg_req09_relay_mixed",
        "type": "message",
        "role": "assistant",
        "model": "req09-relay-mixed-wire",
        "content": [{"type": "text", "text": text}],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": {"input_tokens": 3, "output_tokens": 2}
    })
}

fn gemini_response(text: &str) -> Value {
    json!({
        "candidates": [{
            "index": 0,
            "finishReason": "STOP",
            "content": {"role": "model", "parts": [{"text": text}]}
        }],
        "usageMetadata": {
            "promptTokenCount": 3,
            "candidatesTokenCount": 2,
            "totalTokenCount": 5
        }
    })
}

fn upstream_error_body() -> Value {
    json!({
        "error": {
            "message": UPSTREAM_401_MESSAGE,
            "type": "authentication_error",
            "code": "invalid_api_key"
        }
    })
}

/// Entry protocol bindings with Responses and OpenAI Chat explicitly pinned to
/// Relay. Anthropic and Gemini are Relay in the shared declaration already.
fn relay_declaration() -> String {
    let responses_direct = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let responses_relay = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let chat_direct = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let chat_relay = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    hub_v1_test_declaration()
        .replace(responses_direct, responses_relay)
        .replace(chat_direct, chat_relay)
}

/// Relay-only execution policy: a same-protocol entry must plan as Hub Relay
/// (`relay_only_same_protocol_responses_is_planned_as_hub_relay`), so every
/// entry in this fixture exercises its Relay attempt owner.
fn relay_only_server_execution(server_id: &str) -> String {
    format!(
        r#"
[servers.{server_id}.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
"#
    )
}

/// One provider block for the authoring config.
fn provider_block(
    provider_id: &str,
    provider_type: &str,
    base_url: &str,
    wire_name: &str,
    key_env: &str,
    alias: Option<&str>,
) -> String {
    let aliases = match alias {
        Some(alias) => format!("aliases = [\"{alias}\"]\n"),
        None => String::new(),
    };
    format!(
        r#"
[providers.{provider_id}]
type = "{provider_type}"
base_url = "{base_url}"
default_model = "{wire_name}"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{key_env}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.{provider_id}.models.{wire_name}]
wire_name = "{wire_name}"
{aliases}capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
    )
}

/// One entry protocol's routing group.
///
/// The router always appends the group's `default` pool as the floor tier
/// (`V3VirtualRouter::resolve_route_pool_plan`), so a healthy or cross-protocol
/// `default` lets an exhausted request recover through it. Each group here
/// therefore binds `default` to the same local missing-auth candidate the match
/// pool already failed on, so the selected pool is genuinely exhausted. The
/// healthy pool stays reachable because the independent healthy request selects
/// it by its own model, before the floor tier is ever tried.
#[allow(clippy::too_many_arguments)]
fn relay_route_group(
    group: &str,
    entry_protocol: &str,
    exhaust_visible: &str,
    healthy_visible: &str,
    first_provider: &str,
    first_wire: &str,
    local_provider: &str,
    local_wire: &str,
    healthy_provider: &str,
    healthy_wire: &str,
) -> String {
    format!(
        r#"
[route_groups.{group}.pools.exhaust]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "{entry_protocol}", models = ["{exhaust_visible}"] }}
targets = [
  {{ kind = "provider_model", provider = "{first_provider}", model = "{first_wire}", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "{local_provider}", model = "{local_wire}", key = "key", priority = 1 }}
]

[route_groups.{group}.pools.healthy]
selection = {{ strategy = "priority" }}
match = {{ precedence = 11, entry_protocol = "{entry_protocol}", models = ["{healthy_visible}"] }}
targets = [{{ kind = "provider_model", provider = "{healthy_provider}", model = "{healthy_wire}", key = "key", priority = 1 }}]

[route_groups.{group}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{local_provider}", model = "{local_wire}", key = "key", priority = 1 }}]
"#
    )
}

/// Build the four-listener aggregate manifest.
///
/// The model aliases declared by `provider_block` are retained unchanged. They
/// only add extra visible model ids; the router's direct-route resolver
/// (`resolve_direct_provider_model`) requires a dotted `provider.model` string,
/// and every client model here is dot-free, so the aliases cannot divert a
/// request into direct routing or block admission of the intended candidate.
/// Pool matching compares the raw client model string, so the aliases are not
/// required for selection either; removing them would not change the corrected
/// routing.
#[allow(clippy::too_many_arguments)]
fn req09_relay_mixed_manifest(
    responses_port: u16,
    chat_port: u16,
    anthropic_port: u16,
    gemini_port: u16,
    responses_first_base: &str,
    responses_local_base: &str,
    responses_healthy_base: &str,
    chat_first_base: &str,
    chat_local_base: &str,
    chat_healthy_base: &str,
    anthropic_first_base: &str,
    anthropic_local_base: &str,
    anthropic_healthy_base: &str,
    gemini_first_base: &str,
    gemini_local_base: &str,
    gemini_healthy_base: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = relay_declaration();

    let responses_execution = relay_only_server_execution(RESPONSES_SERVER_ID);
    let chat_execution = relay_only_server_execution(CHAT_SERVER_ID);
    let anthropic_execution = relay_only_server_execution(ANTHROPIC_SERVER_ID);
    let gemini_execution = relay_only_server_execution(GEMINI_SERVER_ID);

    let responses_group = relay_route_group(
        RESPONSES_SERVER_ID,
        "responses",
        "req09-relay-mixed-responses",
        "req09-relay-mixed-responses-healthy",
        "responses_first",
        "responses-first-wire",
        "responses_local",
        "responses-local-wire",
        "responses_healthy",
        "responses-healthy-wire",
    );
    let chat_group = relay_route_group(
        CHAT_SERVER_ID,
        "openai_chat",
        "req09-relay-mixed-chat",
        "req09-relay-mixed-chat-healthy",
        "chat_first",
        "chat-first-wire",
        "chat_local",
        "chat-local-wire",
        "chat_healthy",
        "chat-healthy-wire",
    );
    let anthropic_group = relay_route_group(
        ANTHROPIC_SERVER_ID,
        "anthropic",
        "req09-relay-mixed-anthropic",
        "req09-relay-mixed-anthropic-healthy",
        "anthropic_first",
        "anthropic-first-wire",
        "anthropic_local",
        "anthropic-local-wire",
        "anthropic_healthy",
        "anthropic-healthy-wire",
    );
    let gemini_group = relay_route_group(
        GEMINI_SERVER_ID,
        "gemini",
        "req09-relay-mixed-gemini",
        "req09-relay-mixed-gemini-healthy",
        "gemini_first",
        "gemini-first-wire",
        "gemini_local",
        "gemini-local-wire",
        "gemini_healthy",
        "gemini-healthy-wire",
    );

    // Responses and OpenAI Chat entries target OpenAI Chat providers (Relay).
    // Anthropic and Gemini entries target same-protocol providers forced to
    // Relay by the relay-only policy above.
    let providers = format!(
        "{}{}{}{}{}{}{}{}{}{}{}{}",
        provider_block(
            "responses_first",
            "openai_chat",
            &format!("{responses_first_base}/v1"),
            "responses-first-wire",
            FIRST_KEY_ENV,
            Some("req09-relay-mixed-responses"),
        ),
        provider_block(
            "responses_local",
            "openai_chat",
            &format!("{responses_local_base}/v1"),
            "responses-local-wire",
            MISSING_KEY_ENV,
            None,
        ),
        provider_block(
            "responses_healthy",
            "openai_chat",
            &format!("{responses_healthy_base}/v1"),
            "responses-healthy-wire",
            HEALTHY_KEY_ENV,
            Some("req09-relay-mixed-responses-healthy"),
        ),
        provider_block(
            "chat_first",
            "openai_chat",
            &format!("{chat_first_base}/v1"),
            "chat-first-wire",
            FIRST_KEY_ENV,
            Some("req09-relay-mixed-chat"),
        ),
        provider_block(
            "chat_local",
            "openai_chat",
            &format!("{chat_local_base}/v1"),
            "chat-local-wire",
            MISSING_KEY_ENV,
            None,
        ),
        provider_block(
            "chat_healthy",
            "openai_chat",
            &format!("{chat_healthy_base}/v1"),
            "chat-healthy-wire",
            HEALTHY_KEY_ENV,
            Some("req09-relay-mixed-chat-healthy"),
        ),
        provider_block(
            "anthropic_first",
            "anthropic",
            anthropic_first_base,
            "anthropic-first-wire",
            FIRST_KEY_ENV,
            Some("req09-relay-mixed-anthropic"),
        ),
        provider_block(
            "anthropic_local",
            "anthropic",
            anthropic_local_base,
            "anthropic-local-wire",
            MISSING_KEY_ENV,
            None,
        ),
        provider_block(
            "anthropic_healthy",
            "anthropic",
            anthropic_healthy_base,
            "anthropic-healthy-wire",
            HEALTHY_KEY_ENV,
            Some("req09-relay-mixed-anthropic-healthy"),
        ),
        provider_block(
            "gemini_first",
            "gemini",
            &format!("{gemini_first_base}/v1beta"),
            "gemini-first-wire",
            FIRST_KEY_ENV,
            Some("req09-relay-mixed-gemini"),
        ),
        provider_block(
            "gemini_local",
            "gemini",
            &format!("{gemini_local_base}/v1beta"),
            "gemini-local-wire",
            MISSING_KEY_ENV,
            None,
        ),
        provider_block(
            "gemini_healthy",
            "gemini",
            &format!("{gemini_healthy_base}/v1beta"),
            "gemini-healthy-wire",
            HEALTHY_KEY_ENV,
            Some("req09-relay-mixed-gemini-healthy"),
        ),
    );

    let source = format!(
        r#"
version = 3
{declaration}

[servers.{RESPONSES_SERVER_ID}]
bind = "127.0.0.1"
port = {responses_port}
routing_group = "{RESPONSES_SERVER_ID}"
endpoints = ["responses"]
{responses_execution}

[servers.{CHAT_SERVER_ID}]
bind = "127.0.0.1"
port = {chat_port}
routing_group = "{CHAT_SERVER_ID}"
endpoints = ["openai_chat"]
{chat_execution}

[servers.{ANTHROPIC_SERVER_ID}]
bind = "127.0.0.1"
port = {anthropic_port}
routing_group = "{ANTHROPIC_SERVER_ID}"
endpoints = ["anthropic"]
{anthropic_execution}

[servers.{GEMINI_SERVER_ID}]
bind = "127.0.0.1"
port = {gemini_port}
routing_group = "{GEMINI_SERVER_ID}"
endpoints = ["gemini"]
{gemini_execution}
{providers}
[debug]
log_console = true
snapshots = true
codex_samples = true
snapshot_stages = "client-request,client-response"
dry_run = false
retention = {{ raw_requests = 32, raw_responses = 32, events = 512 }}

{responses_group}
{chat_group}
{anthropic_group}
{gemini_group}
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

/// Sandbox-safe authoring check for the routing correction.
///
/// The public test cannot bind a loopback listener under the Codex sandbox
/// (EPERM), so this test exercises only the real config compiler and asserts the
/// shape of the four reduced routing groups the correction introduces. It is not
/// a behavioral substitute for the public run: the host still has to drive the
/// aggregate through the four real listeners.
#[test]
fn req09_relay_mixed_manifest_binds_default_to_the_local_missing_auth_candidate() {
    let base = "http://127.0.0.1:9";
    let manifest = req09_relay_mixed_manifest(
        41801, 41802, 41803, 41804, base, base, base, base, base, base, base, base, base, base,
        base, base,
    );

    for server_id in [
        RESPONSES_SERVER_ID,
        CHAT_SERVER_ID,
        ANTHROPIC_SERVER_ID,
        GEMINI_SERVER_ID,
    ] {
        let server = manifest
            .servers
            .get(server_id)
            .unwrap_or_else(|| panic!("missing server {server_id}"));
        assert_eq!(
            server.routing_group, server_id,
            "each entry protocol must own its own routing group"
        );
        assert_eq!(
            server.endpoints.len(),
            1,
            "{server_id}: one listener serves exactly one entry protocol"
        );

        let group = manifest
            .route_groups
            .get(server_id)
            .unwrap_or_else(|| panic!("missing routing group {server_id}"));
        assert_eq!(
            group.pools.len(),
            3,
            "{server_id}: exhaust + healthy + default"
        );

        let exhaust = group.pools.get("exhaust").expect("exhaust pool");
        let healthy = group.pools.get("healthy").expect("healthy pool");
        let default_pool = group.pools.get("default").expect("default pool");

        let first_provider = exhaust.targets[0].provider.as_deref().unwrap();
        let local_provider = exhaust.targets[1].provider.as_deref().unwrap();
        let healthy_provider = healthy.targets[0].provider.as_deref().unwrap();
        let default_provider = default_pool.targets[0].provider.as_deref().unwrap();

        assert!(
            first_provider.ends_with("_first"),
            "{server_id}: first candidate must be the real-401 upstream, got {first_provider}"
        );
        assert!(
            local_provider.ends_with("_local"),
            "{server_id}: second candidate must be the local missing-auth provider, got \
             {local_provider}"
        );
        assert_eq!(
            default_provider, local_provider,
            "{server_id}: the default floor must be the same local missing-auth candidate, not a \
             healthy or cross-protocol target"
        );
        assert!(
            healthy_provider.ends_with("_healthy"),
            "{server_id}: the healthy pool must stay reachable through its own provider, got \
             {healthy_provider}"
        );
        assert_ne!(
            exhaust.match_rule.as_ref().unwrap().models,
            healthy.match_rule.as_ref().unwrap().models,
            "{server_id}: the exhaust and healthy requests must select different pools by model"
        );
    }
}

/// The native Responses request that preserves an ordinary `exec_command`
/// function declaration, a native free-text `custom` `apply_patch` declaration,
/// and an MCP function declaration, each paired with its call/output history.
/// The exec command is >= 4096 bytes, the patch is a full multi-line
/// free-form document, and the MCP argument is an opaque string.
fn responses_tool_fidelity_request(model: &str, marker: &str) -> Value {
    json!({
        "model": model,
        "stream": false,
        "tools": [
            {"type": "function", "name": "exec_command", "description": TOOL_SCHEMA_MARKER, "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]}},
            {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
            {"type": "function", "name": "mcp__req09_relay__opaque_tool", "description": TOOL_SCHEMA_MARKER, "parameters": {"type": "object", "properties": {"opaque": {"type": "string"}}, "required": ["opaque"]}}
        ],
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": marker}]},
            {"type": "function_call", "call_id": EXEC_CALL_ID, "name": "exec_command", "arguments": req09_exec_arguments()},
            {"type": "function_call_output", "call_id": EXEC_CALL_ID, "output": req09_exec_result()},
            {"type": "custom_tool_call", "call_id": PATCH_CALL_ID, "name": "apply_patch", "input": req09_patch_input()},
            {"type": "custom_tool_call_output", "call_id": PATCH_CALL_ID, "output": req09_patch_result()},
            {"type": "function_call", "call_id": MCP_CALL_ID, "name": "mcp__req09_relay__opaque_tool", "arguments": req09_mcp_arguments()},
            {"type": "function_call_output", "call_id": MCP_CALL_ID, "output": req09_mcp_result()}
        ]
    })
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn find_sample_with_request_marker(root: &Path, marker: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) != Some("request.json") {
                continue;
            }
            let Some(request) = fs::read_to_string(&path).ok() else {
                continue;
            };
            if request.contains(marker) {
                return path.parent().map(Path::to_path_buf);
            }
        }
    }
    None
}

async fn wait_for_sample_with_request_marker(root: &Path, marker: &str) -> Option<PathBuf> {
    for _ in 0..400 {
        if let Some(path) = find_sample_with_request_marker(root, marker) {
            return Some(path);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    None
}

async fn wait_for_json_file(path: &Path) -> Option<Value> {
    for _ in 0..80 {
        if let Some(value) = read_json_file(path) {
            return Some(value);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    None
}

#[derive(Debug)]
enum ClientObservation {
    HeaderlessClose(String),
    Response {
        status: StatusCode,
        body: Result<String, String>,
    },
    Timeout,
}

async fn observe_request(client: &reqwest::Client, url: String, body: Value) -> ClientObservation {
    match timeout(Duration::from_secs(10), client.post(url).json(&body).send()).await {
        Ok(Ok(response)) => {
            let status = response.status();
            let body = match timeout(Duration::from_secs(5), response.text()).await {
                Ok(Ok(body)) => Ok(body),
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err("client response body timed out".to_string()),
            };
            ClientObservation::Response { status, body }
        }
        Ok(Err(error)) => ClientObservation::HeaderlessClose(error.to_string()),
        Err(_) => ClientObservation::Timeout,
    }
}

/// A terminal local failure must break the client transport without any HTTP
/// response, error status, or provider error envelope.
fn assert_client_transport_incomplete(label: &str, observation: ClientObservation) {
    match observation {
        ClientObservation::HeaderlessClose(error) => {
            assert!(
                !error.is_empty(),
                "{label}: headerless client close must carry the transport error"
            );
        }
        ClientObservation::Response { status, body } => {
            panic!(
                "{label}: terminal local failure must not project an HTTP response or provider \
                 error JSON: status={status}, body={body:?}"
            );
        }
        ClientObservation::Timeout => {
            panic!(
                "{label}: terminal local failure must end the client transport before the deadline"
            );
        }
    }
}

fn assert_no_client_error_body(label: &str, body: &Value) {
    assert!(
        body.get("error").is_none() || body["error"].is_null(),
        "{label}: client body must not contain an error object: {body}"
    );
    assert!(
        body["type"] != "error",
        "{label}: client body must not be an error envelope: {body}"
    );
    assert!(
        !body.to_string().contains("response.failed"),
        "{label}: client body must not contain response.failed: {body}"
    );
    assert!(
        !body.to_string().contains("event: error"),
        "{label}: client body must not contain an SSE error event: {body}"
    );
}

/// Locate the projected OpenAI Chat assistant `tool_calls` entry for one call
/// id. Pairing is proven by id, not by a whole-body substring.
fn find_chat_tool_call<'a>(body: &'a Value, call_id: &str) -> Option<&'a Value> {
    body["messages"].as_array()?.iter().find_map(|message| {
        message
            .get("tool_calls")
            .and_then(Value::as_array)
            .and_then(|tool_calls| tool_calls.iter().find(|call| call["id"] == call_id))
    })
}

/// Locate the projected OpenAI Chat `role=tool` result bound to one call id.
fn find_chat_tool_result<'a>(body: &'a Value, call_id: &str) -> Option<&'a Value> {
    body["messages"]
        .as_array()?
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
}

/// Compare a Chat wire `function.arguments` string as an opaque JSON value. The
/// fixture never assigns business meaning to the payload, so equivalence is
/// JSON-value equality on the preserved opaque string.
fn chat_wire_arguments_json(tool_call: &Value) -> Value {
    let arguments = tool_call["function"]["arguments"]
        .as_str()
        .unwrap_or_else(|| panic!("Chat wire tool call must carry string arguments: {tool_call}"));
    serde_json::from_str(arguments).unwrap_or_else(|error| {
        panic!("Chat wire tool arguments must remain valid JSON: {error}: {arguments}")
    })
}

/// The request-bound evidence for the exhausted request.
///
/// Only the sample objects this consumer's Relay path actually writes are
/// asserted here: `request.json` (the bound request marker) and
/// `provider-terminal.json` (the terminal provider disposition). A local
/// missing-auth terminal has no external HTTP witness, so the terminal must be
/// `no_response` with no status and no earlier 401 body.
///
/// The same request must also retain its internal typed Error evidence. Console
/// event projection is covered by the separate diagnostic consumer.
async fn assert_local_source_without_inherited_witness(
    label: &str,
    sample_dir: &Path,
    exhaust_marker: &str,
) {
    let request_json =
        read_json_file(&sample_dir.join("request.json")).expect("request.json must be parseable");
    assert!(
        request_json.to_string().contains(exhaust_marker),
        "{label}: request.json must preserve the opaque marker: {request_json}"
    );
    let provider_terminal = read_json_file(&sample_dir.join("provider-terminal.json"))
        .unwrap_or_else(|| {
            panic!(
                "{label}: request-bound provider-terminal.json must exist for the exhausted request"
            )
        });
    assert_eq!(
        provider_terminal["kind"], "no_response",
        "{label}: a local missing-auth terminal has no external HTTP witness: {provider_terminal}"
    );
    assert!(
        provider_terminal.get("status").is_none(),
        "{label}: a no_response terminal must not project an external status: {provider_terminal}"
    );
    assert!(
        provider_terminal.get("body").is_none(),
        "{label}: a no_response terminal must not carry a provider body: {provider_terminal}"
    );
    assert!(
        !provider_terminal.to_string().contains(UPSTREAM_401_MESSAGE),
        "{label}: the no_response terminal must not carry an earlier provider 401 body: \
         {provider_terminal}"
    );

    let error_json = wait_for_json_file(&sample_dir.join("error.json"))
        .await
        .unwrap_or_else(|| panic!("{label}: terminal internal Error evidence must exist"));
    assert_eq!(
        error_json["object"], "routecodex.v3.error_evidence",
        "{label}: request-bound Error evidence must keep its typed object: {error_json}"
    );
    assert_eq!(error_json["stage"], "error", "{label}: {error_json}");
    assert_eq!(error_json["status"], 598, "{label}: {error_json}");
    assert_eq!(
        error_json["request_id"],
        sample_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap(),
        "{label}: Error evidence must bind to the same request: {error_json}"
    );
    for node in ["V3Error01SourceRaised", "V3Error06ClientProjected"] {
        assert!(
            error_json["error_chain"]
                .as_array()
                .is_some_and(|chain| chain.iter().any(|value| value == node)),
            "{label}: Error evidence must retain {node}: {error_json}"
        );
    }
}

async fn shutdown_upstream(upstream: Upstream, label: &str) {
    upstream
        .shutdown
        .send(())
        .expect("upstream shutdown receiver");
    timeout(Duration::from_secs(5), upstream.task)
        .await
        .unwrap_or_else(|_| panic!("{label}: upstream shutdown timed out"))
        .unwrap_or_else(|error| panic!("{label}: upstream task failed: {error}"));
}

/// The bound address of one aggregate listener, resolved by its declared server
/// id. Each entry protocol runs on its own listener, so a public request must be
/// sent to the matching address instead of the first listener in the aggregate.
fn listener_addr(handle: &V3ServerAggregateHandle, server_id: &str) -> SocketAddr {
    handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == server_id)
        .map(|listener| listener.addr)
        .unwrap_or_else(|| panic!("aggregate must expose a listener for {server_id}"))
}

#[tokio::test]
async fn req09_relay_mixed_external_401_then_local_failure_exhausts_all_four_protocols_blackbox() {
    let _test_guard = TEST_LOCK.lock().await;
    let home_guard = TestHomeGuard::new("four-protocols");

    // First candidates: real loopback upstreams answering a real HTTP 401.
    let mut responses_first = start_upstream(
        "/v1/chat/completions".to_string(),
        StatusCode::UNAUTHORIZED,
        upstream_error_body(),
    )
    .await;
    let mut chat_first = start_upstream(
        "/v1/chat/completions".to_string(),
        StatusCode::UNAUTHORIZED,
        upstream_error_body(),
    )
    .await;
    let mut anthropic_first = start_upstream(
        "/v1/messages".to_string(),
        StatusCode::UNAUTHORIZED,
        upstream_error_body(),
    )
    .await;
    let mut gemini_first = start_upstream(
        "/v1beta/models/gemini-first-wire:generateContent".to_string(),
        StatusCode::UNAUTHORIZED,
        upstream_error_body(),
    )
    .await;

    // Local missing-auth candidates: guard upstreams that must never be reached.
    let mut responses_local = start_local_guard_upstream().await;
    let mut chat_local = start_local_guard_upstream().await;
    let mut anthropic_local = start_local_guard_upstream().await;
    let mut gemini_local = start_local_guard_upstream().await;

    // Independent healthy candidates: real loopback upstreams answering success.
    let mut responses_healthy = start_upstream(
        "/v1/chat/completions".to_string(),
        StatusCode::OK,
        chat_response("req09 relay responses healthy ok"),
    )
    .await;
    let mut chat_healthy = start_upstream(
        "/v1/chat/completions".to_string(),
        StatusCode::OK,
        chat_response("req09 relay chat healthy ok"),
    )
    .await;
    let mut anthropic_healthy = start_upstream(
        "/v1/messages".to_string(),
        StatusCode::OK,
        anthropic_response("req09 relay anthropic healthy ok"),
    )
    .await;
    let mut gemini_healthy = start_upstream(
        "/v1beta/models/gemini-healthy-wire:generateContent".to_string(),
        StatusCode::OK,
        gemini_response("req09 relay gemini healthy ok"),
    )
    .await;

    let manifest = req09_relay_mixed_manifest(
        free_port(),
        free_port(),
        free_port(),
        free_port(),
        &responses_first.base_url,
        &responses_local.base_url,
        &responses_healthy.base_url,
        &chat_first.base_url,
        &chat_local.base_url,
        &chat_healthy.base_url,
        &anthropic_first.base_url,
        &anthropic_local.base_url,
        &anthropic_healthy.base_url,
        &gemini_first.base_url,
        &gemini_local.base_url,
        &gemini_healthy.base_url,
    );

    let mut server_start_error = None;
    let handle = match spawn_v3_server_aggregate(manifest).await {
        Ok(handle) => Some(handle),
        Err(error) => {
            server_start_error = Some(error.to_string());
            None
        }
    };

    let mut chat_exhaust_observation = None;
    let mut responses_exhaust_observation = None;
    let mut anthropic_exhaust_observation = None;
    let mut gemini_exhaust_observation = None;
    let mut chat_healthy_body = None;
    let mut responses_healthy_body = None;
    let mut anthropic_healthy_body = None;
    let mut gemini_healthy_body = None;
    let mut sample_dirs: Vec<(&'static str, &'static str, PathBuf)> = Vec::new();

    if let Some(handle) = handle.as_ref() {
        let responses_addr = listener_addr(handle, RESPONSES_SERVER_ID);
        let chat_addr = listener_addr(handle, CHAT_SERVER_ID);
        let anthropic_addr = listener_addr(handle, ANTHROPIC_SERVER_ID);
        let gemini_addr = listener_addr(handle, GEMINI_SERVER_ID);
        let client = reqwest::Client::new();
        let samples_root = home_guard.samples_root();

        // 1. Minimum Chat case first.
        chat_exhaust_observation = Some(
            observe_request(
                &client,
                format!("http://{chat_addr}/v1/chat/completions"),
                json!({
                    "model": "req09-relay-mixed-chat",
                    "messages": [{"role": "user", "content": CHAT_EXHAUST_MARKER}],
                    "stream": false
                }),
            )
            .await,
        );
        if let Some(dir) =
            wait_for_sample_with_request_marker(&samples_root, CHAT_EXHAUST_MARKER).await
        {
            sample_dirs.push(("OpenAI Chat", CHAT_EXHAUST_MARKER, dir));
        }
        chat_healthy_body = Some(
            observe_request(
                &client,
                format!("http://{chat_addr}/v1/chat/completions"),
                json!({
                    "model": "req09-relay-mixed-chat-healthy",
                    "messages": [{"role": "user", "content": CHAT_HEALTHY_MARKER}],
                    "stream": false
                }),
            )
            .await,
        );

        // 2. Responses entry (Relay), with the full tool payload preserved.
        responses_exhaust_observation = Some(
            observe_request(
                &client,
                format!("http://{responses_addr}/v1/responses"),
                json!({
                    "model": "req09-relay-mixed-responses",
                    "input": RESPONSES_EXHAUST_MARKER,
                    "stream": false
                }),
            )
            .await,
        );
        if let Some(dir) =
            wait_for_sample_with_request_marker(&samples_root, RESPONSES_EXHAUST_MARKER).await
        {
            sample_dirs.push(("Responses", RESPONSES_EXHAUST_MARKER, dir));
        }
        responses_healthy_body = Some(
            observe_request(
                &client,
                format!("http://{responses_addr}/v1/responses"),
                responses_tool_fidelity_request(
                    "req09-relay-mixed-responses-healthy",
                    RESPONSES_HEALTHY_MARKER,
                ),
            )
            .await,
        );

        // 3. Anthropic entry.
        anthropic_exhaust_observation = Some(
            observe_request(
                &client,
                format!("http://{anthropic_addr}/v1/messages"),
                json!({
                    "model": "req09-relay-mixed-anthropic",
                    "max_tokens": 64,
                    "messages": [{"role": "user", "content": ANTHROPIC_EXHAUST_MARKER}],
                    "stream": false
                }),
            )
            .await,
        );
        if let Some(dir) =
            wait_for_sample_with_request_marker(&samples_root, ANTHROPIC_EXHAUST_MARKER).await
        {
            sample_dirs.push(("Anthropic", ANTHROPIC_EXHAUST_MARKER, dir));
        }
        anthropic_healthy_body = Some(
            observe_request(
                &client,
                format!("http://{anthropic_addr}/v1/messages"),
                json!({
                    "model": "req09-relay-mixed-anthropic-healthy",
                    "max_tokens": 64,
                    "messages": [{"role": "user", "content": ANTHROPIC_HEALTHY_MARKER}],
                    "stream": false
                }),
            )
            .await,
        );

        // 4. Gemini generateContent entry.
        gemini_exhaust_observation = Some(
            observe_request(
                &client,
                format!(
                    "http://{gemini_addr}/v1beta/models/req09-relay-mixed-gemini/generateContent"
                ),
                json!({
                    "contents": [{"role": "user", "parts": [{"text": GEMINI_EXHAUST_MARKER}]}],
                    "stream": false
                }),
            )
            .await,
        );
        if let Some(dir) =
            wait_for_sample_with_request_marker(&samples_root, GEMINI_EXHAUST_MARKER).await
        {
            sample_dirs.push(("Gemini", GEMINI_EXHAUST_MARKER, dir));
        }
        gemini_healthy_body = Some(
            observe_request(
                &client,
                format!(
                    "http://{gemini_addr}/v1beta/models/req09-relay-mixed-gemini-healthy/generateContent"
                ),
                json!({
                    "contents": [{"role": "user", "parts": [{"text": GEMINI_HEALTHY_MARKER}]}],
                    "stream": false
                }),
            )
            .await,
        );
    }

    // Collect captures and shut everything down before asserting so failures do
    // not leak loopback tasks.
    let chat_first_capture = timeout(Duration::from_secs(5), chat_first.captures.recv())
        .await
        .ok()
        .flatten();
    let responses_first_capture = timeout(Duration::from_secs(5), responses_first.captures.recv())
        .await
        .ok()
        .flatten();
    let anthropic_first_capture = timeout(Duration::from_secs(5), anthropic_first.captures.recv())
        .await
        .ok()
        .flatten();
    let gemini_first_capture = timeout(Duration::from_secs(5), gemini_first.captures.recv())
        .await
        .ok()
        .flatten();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let responses_healthy_capture = responses_healthy.captures.try_recv().ok();
    let chat_healthy_capture = chat_healthy.captures.try_recv().ok();
    let anthropic_healthy_capture = anthropic_healthy.captures.try_recv().ok();
    let gemini_healthy_capture = gemini_healthy.captures.try_recv().ok();
    let responses_local_capture = responses_local.captures.try_recv().ok();
    let chat_local_capture = chat_local.captures.try_recv().ok();
    let anthropic_local_capture = anthropic_local.captures.try_recv().ok();
    let gemini_local_capture = gemini_local.captures.try_recv().ok();
    assert!(
        responses_local_capture.is_none()
            && chat_local_capture.is_none()
            && anthropic_local_capture.is_none()
            && gemini_local_capture.is_none(),
        "the missing-auth candidates must not send a network request"
    );

    let shutdown_failures = if let Some(handle) = handle {
        timeout(Duration::from_secs(5), handle.shutdown())
            .await
            .expect("aggregate server shutdown must complete")
    } else {
        Vec::new()
    };

    shutdown_upstream(chat_first, "chat first 401 upstream").await;
    shutdown_upstream(responses_first, "responses first 401 upstream").await;
    shutdown_upstream(anthropic_first, "anthropic first 401 upstream").await;
    shutdown_upstream(gemini_first, "gemini first 401 upstream").await;
    shutdown_upstream(chat_local, "chat local guard upstream").await;
    shutdown_upstream(responses_local, "responses local guard upstream").await;
    shutdown_upstream(anthropic_local, "anthropic local guard upstream").await;
    shutdown_upstream(gemini_local, "gemini local guard upstream").await;
    shutdown_upstream(chat_healthy, "chat healthy upstream").await;
    shutdown_upstream(responses_healthy, "responses healthy upstream").await;
    shutdown_upstream(anthropic_healthy, "anthropic healthy upstream").await;
    shutdown_upstream(gemini_healthy, "gemini healthy upstream").await;

    assert!(
        server_start_error.is_none(),
        "aggregate server must start: {server_start_error:?}"
    );
    assert!(
        shutdown_failures.is_empty(),
        "sample persistence failures: {shutdown_failures:?}"
    );

    // Exhausted requests: real first HTTP attempt happened, the local candidate
    // never sent a request, and the client transport broke without a response.
    assert!(
        chat_first_capture
            .as_ref()
            .is_some_and(|capture| capture.to_string().contains(CHAT_EXHAUST_MARKER)),
        "OpenAI Chat first candidate must receive exactly one real request: {chat_first_capture:?}"
    );
    assert!(
        responses_first_capture
            .as_ref()
            .is_some_and(|capture| capture.to_string().contains(RESPONSES_EXHAUST_MARKER)),
        "Responses first candidate must receive exactly one real request: {responses_first_capture:?}"
    );
    assert!(
        anthropic_first_capture
            .as_ref()
            .is_some_and(|capture| capture.to_string().contains(ANTHROPIC_EXHAUST_MARKER)),
        "Anthropic first candidate must receive exactly one real request: {anthropic_first_capture:?}"
    );
    assert!(
        gemini_first_capture
            .as_ref()
            .is_some_and(|capture| capture.to_string().contains(GEMINI_EXHAUST_MARKER)),
        "Gemini first candidate must receive exactly one real request: {gemini_first_capture:?}"
    );

    assert_client_transport_incomplete(
        "OpenAI Chat exhaustion",
        chat_exhaust_observation.expect("chat exhaustion observation must be collected"),
    );
    assert_client_transport_incomplete(
        "Responses exhaustion",
        responses_exhaust_observation.expect("responses exhaustion observation must be collected"),
    );
    assert_client_transport_incomplete(
        "Anthropic exhaustion",
        anthropic_exhaust_observation.expect("anthropic exhaustion observation must be collected"),
    );
    assert_client_transport_incomplete(
        "Gemini exhaustion",
        gemini_exhaust_observation.expect("gemini exhaustion observation must be collected"),
    );

    let sample_dir_for = |label: &str, marker: &str| -> PathBuf {
        sample_dirs
            .iter()
            .find(|(case, case_marker, _)| *case == label && *case_marker == marker)
            .map(|(_, _, path)| path.clone())
            .unwrap_or_else(|| {
                panic!("{label}: request-bound sample for marker {marker} must exist")
            })
    };
    assert_local_source_without_inherited_witness(
        "OpenAI Chat",
        &sample_dir_for("OpenAI Chat", CHAT_EXHAUST_MARKER),
        CHAT_EXHAUST_MARKER,
    )
    .await;
    assert_local_source_without_inherited_witness(
        "Responses",
        &sample_dir_for("Responses", RESPONSES_EXHAUST_MARKER),
        RESPONSES_EXHAUST_MARKER,
    )
    .await;
    assert_local_source_without_inherited_witness(
        "Anthropic",
        &sample_dir_for("Anthropic", ANTHROPIC_EXHAUST_MARKER),
        ANTHROPIC_EXHAUST_MARKER,
    )
    .await;
    assert_local_source_without_inherited_witness(
        "Gemini",
        &sample_dir_for("Gemini", GEMINI_EXHAUST_MARKER),
        GEMINI_EXHAUST_MARKER,
    )
    .await;

    // Independent healthy requests succeed on the same aggregate.
    match chat_healthy_body.expect("chat healthy observation must be collected") {
        ClientObservation::Response {
            status,
            body: Ok(body),
        } => {
            assert_eq!(status, StatusCode::OK, "{body}");
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                body["choices"][0]["message"]["content"], "req09 relay chat healthy ok",
                "{body}"
            );
            assert_no_client_error_body("OpenAI Chat healthy", &body);
        }
        other => panic!("OpenAI Chat healthy request must return completed JSON: {other:?}"),
    }
    match responses_healthy_body.expect("responses healthy observation must be collected") {
        ClientObservation::Response {
            status,
            body: Ok(body),
        } => {
            assert_eq!(status, StatusCode::OK, "{body}");
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["status"], "completed", "{body}");
            assert!(
                body.to_string()
                    .contains("req09 relay responses healthy ok"),
                "Responses healthy request must return the projected upstream text: {body}"
            );
            assert_no_client_error_body("Responses healthy", &body);
        }
        other => panic!("Responses healthy request must return completed JSON: {other:?}"),
    }
    match anthropic_healthy_body.expect("anthropic healthy observation must be collected") {
        ClientObservation::Response {
            status,
            body: Ok(body),
        } => {
            assert_eq!(status, StatusCode::OK, "{body}");
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                body["content"][0]["text"], "req09 relay anthropic healthy ok",
                "{body}"
            );
            assert_no_client_error_body("Anthropic healthy", &body);
        }
        other => panic!("Anthropic healthy request must return completed JSON: {other:?}"),
    }
    match gemini_healthy_body.expect("gemini healthy observation must be collected") {
        ClientObservation::Response {
            status,
            body: Ok(body),
        } => {
            assert_eq!(status, StatusCode::OK, "{body}");
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(
                body["candidates"][0]["content"]["parts"][0]["text"],
                "req09 relay gemini healthy ok",
                "{body}"
            );
            assert_no_client_error_body("Gemini healthy", &body);
        }
        other => panic!("Gemini healthy request must return completed JSON: {other:?}"),
    }

    assert!(
        chat_healthy_capture
            .as_ref()
            .is_some_and(|capture| capture.to_string().contains(CHAT_HEALTHY_MARKER)),
        "OpenAI Chat healthy upstream must receive its marker: {chat_healthy_capture:?}"
    );
    assert!(
        anthropic_healthy_capture
            .as_ref()
            .is_some_and(|capture| capture.to_string().contains(ANTHROPIC_HEALTHY_MARKER)),
        "Anthropic healthy upstream must receive its marker: {anthropic_healthy_capture:?}"
    );
    assert!(
        gemini_healthy_capture
            .as_ref()
            .is_some_and(|capture| capture.to_string().contains(GEMINI_HEALTHY_MARKER)),
        "Gemini healthy upstream must receive its marker: {gemini_healthy_capture:?}"
    );

    // The Responses healthy request carries the full exec / free-text patch /
    // MCP tool payload; the projected OpenAI Chat wire must preserve every
    // declaration, argument and paired result.
    let responses_healthy_capture = responses_healthy_capture
        .expect("Responses healthy upstream must receive the tool payload");
    let serialized = responses_healthy_capture.to_string();
    assert!(
        serialized.contains(RESPONSES_HEALTHY_MARKER),
        "Responses healthy request marker must reach the upstream intact: {responses_healthy_capture}"
    );
    assert!(
        serialized.contains(TOOL_SCHEMA_MARKER),
        "tool schema text must reach the upstream intact: {responses_healthy_capture}"
    );
    for tool_name in [
        "exec_command",
        "apply_patch",
        "mcp__req09_relay__opaque_tool",
    ] {
        assert!(
            serialized.contains(tool_name),
            "tool declaration {tool_name} must reach the upstream intact: {responses_healthy_capture}"
        );
    }
    for (call_id, marker) in [
        (EXEC_CALL_ID, EXEC_ARGUMENT_MARKER),
        (PATCH_CALL_ID, PATCH_BODY_MARKER),
        (MCP_CALL_ID, MCP_ARGUMENT_MARKER),
        (EXEC_CALL_ID, EXEC_RESULT_MARKER),
        (PATCH_CALL_ID, PATCH_RESULT_MARKER),
        (MCP_CALL_ID, MCP_RESULT_MARKER),
    ] {
        assert!(
            serialized.contains(call_id) && serialized.contains(marker),
            "the paired {call_id} call/output ({marker}) must reach the upstream intact: \
             {responses_healthy_capture}"
        );
    }

    // The substring checks above cannot prove pairing. The projected OpenAI Chat
    // wire must carry one `tool_calls` entry per call id and one `role=tool`
    // message bound to the same id, with the declared name, arguments and result
    // preserved. A `custom` declaration is projected to the Chat `function`
    // surface it was declared as, with the free-form patch wrapped in the
    // declared `input` string; the assertion follows that projection instead of
    // pinning a model-specific shape.
    for tool_name in [
        "exec_command",
        "apply_patch",
        "mcp__req09_relay__opaque_tool",
    ] {
        assert!(
            responses_healthy_capture["tools"]
                .as_array()
                .is_some_and(|tools| {
                    tools.iter().any(|tool| {
                        tool["type"] == "function" && tool["function"]["name"] == tool_name
                    })
                }),
            "declared tool {tool_name} must reach the Chat upstream as a function \
             declaration: {responses_healthy_capture}"
        );
    }
    for call_id in [EXEC_CALL_ID, PATCH_CALL_ID, MCP_CALL_ID] {
        let tool_calls = responses_healthy_capture["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message.get("tool_calls").and_then(Value::as_array))
            .flat_map(|tool_calls| tool_calls.iter())
            .filter(|call| call["id"] == call_id)
            .count();
        assert_eq!(
            tool_calls, 1,
            "exactly one assistant tool_calls entry may carry {call_id}: \
             {responses_healthy_capture}"
        );
    }
    for (call_id, name, arguments, result) in [
        (
            EXEC_CALL_ID,
            "exec_command",
            json!({"cmd": req09_exec_command()}),
            req09_exec_result(),
        ),
        (
            PATCH_CALL_ID,
            "apply_patch",
            json!({"input": req09_patch_input()}),
            req09_patch_result(),
        ),
        (
            MCP_CALL_ID,
            "mcp__req09_relay__opaque_tool",
            json!({"opaque": req09_mcp_argument()}),
            req09_mcp_result(),
        ),
    ] {
        let tool_call =
            find_chat_tool_call(&responses_healthy_capture, call_id).unwrap_or_else(|| {
                panic!(
                    "call {call_id} must reach the OpenAI Chat provider wire: \
                     {responses_healthy_capture}"
                )
            });
        assert_eq!(
            tool_call["type"], "function",
            "call {call_id} must stay on the Chat function surface: {tool_call}"
        );
        assert_eq!(
            tool_call["function"]["name"], name,
            "call {call_id} must keep its declared tool name: {tool_call}"
        );
        assert_eq!(
            chat_wire_arguments_json(tool_call),
            arguments,
            "call {call_id} must preserve its opaque arguments as a JSON value: {tool_call}"
        );
        let tool_result = find_chat_tool_result(&responses_healthy_capture, call_id)
            .unwrap_or_else(|| {
                panic!(
                    "call {call_id} must reach a matched role=tool result: \
                     {responses_healthy_capture}"
                )
            });
        assert_eq!(
            tool_result["role"], "tool",
            "the matched result for {call_id} must use the tool role: {tool_result}"
        );
        assert_eq!(
            tool_result["tool_call_id"], call_id,
            "the matched result must stay bound to {call_id}: {tool_result}"
        );
        assert_eq!(
            tool_result["content"], result,
            "the role=tool result for {call_id} must preserve its opaque payload: {tool_result}"
        );
    }
}
