//! Real-entry replay for the observability vertical.
//!
//! A genuinely failing provider request must leave behind a real observability
//! row whose typed error truth, provider cooldown entry, and debug artifact
//! reference were all produced by the runtime. Nothing here is constructed by
//! the test: the mock upstream really fails, the real listener really serves
//! the request, the real runtime really writes the store and the sample
//! directory, and every assertion is read back through the admin HTTP surface.
//!
//! Harness shape is the one already used by `multi_listener_server.rs` (temp
//! `HOME`, mock axum upstream, compiled authoring config) and
//! `admin_webui_managed.rs` (one aggregate process serving both the data
//! listener and the admin WebUI on its own listener).

#![allow(clippy::clone_on_copy)]

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Router,
};
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::time::{sleep, Duration, Instant};

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Entry-protocol binding for the `responses` endpoint. Copied from the
/// established `multi_listener_server.rs` fixture: the pipeline declaration is
/// what makes `/v1/responses` reach the real Responses runtime.
const HUB_V1_TEST_DECLARATION: &str = r#"
[pipelines.hub_v1]
skeleton = "hub_v1"
entry_protocols = ["responses", "anthropic", "gemini", "openai_chat"]
hook_set_id = "hub_v1.default"
entry_protocol_bindings = [
  { entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" },
  { entry_protocol = "anthropic", endpoint_patterns = ["/v1/messages"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_anthropic_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs" },
  { entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" },
  { entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "relay", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending or direct runtime.", runtime_owner_symbol = "execute_v3_gemini_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs" },
]
resources = { metadata_center = { kind = "control", scope = "request" }, error_chain = { kind = "error", scope = "request" }, debug_artifact = { kind = "debug", scope = "debug" }, snapshot_buffer = { kind = "snapshot", scope = "debug" }, provider_health = { kind = "provider_health", scope = "provider" } }
hooks = [
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.entry.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "entry", requirement = "required", priority = 0, order = 0, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.exit.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "exit", requirement = "required", priority = 0, order = 1, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.entry.not_implemented", node = "V3HubReqInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 2, allowed_resources = ["metadata_center"], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.exit.not_implemented", node = "V3HubReqInbound02Normalized", phase = "exit", requirement = "optional", enabled = false, priority = 0, order = 3, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.entry.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "entry", requirement = "required", priority = 0, order = 4, allowed_resources = [], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.exit.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "exit", requirement = "required", priority = 0, order = 5, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.entry.not_implemented", node = "V3HubReqExecution05Planned", phase = "entry", requirement = "required", priority = 0, order = 6, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.exit.not_implemented", node = "V3HubReqExecution05Planned", phase = "exit", requirement = "required", priority = 0, order = 7, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.entry.not_implemented", node = "V3HubReqTarget06Resolved", phase = "entry", requirement = "required", priority = 0, order = 8, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.exit.not_implemented", node = "V3HubReqTarget06Resolved", phase = "exit", requirement = "required", priority = 0, order = 9, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.entry.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "entry", requirement = "required", priority = 0, order = 10, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.exit.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "exit", requirement = "required", priority = 0, order = 11, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderReqCompat06ProviderCompat.entry.not_implemented", node = "ProviderReqCompat06ProviderCompat", phase = "entry", requirement = "required", priority = 0, order = 12, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderReqCompat06ProviderCompat.exit.not_implemented", node = "ProviderReqCompat06ProviderCompat", phase = "exit", requirement = "required", priority = 0, order = 13, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.entry.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "entry", requirement = "required", priority = 0, order = 14, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.exit.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "exit", requirement = "required", priority = 0, order = 15, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.entry.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "entry", requirement = "required", priority = 0, order = 16, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.exit.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "exit", requirement = "required", priority = 0, order = 17, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.entry.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "entry", requirement = "required", priority = 0, order = 18, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.exit.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "exit", requirement = "required", priority = 0, order = 19, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderRespCompat02ProviderCompat.entry.not_implemented", node = "ProviderRespCompat02ProviderCompat", phase = "entry", requirement = "required", priority = 0, order = 20, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderRespCompat02ProviderCompat.exit.not_implemented", node = "ProviderRespCompat02ProviderCompat", phase = "exit", requirement = "required", priority = 0, order = 21, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.entry.not_implemented", node = "V3HubRespInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 22, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.exit.not_implemented", node = "V3HubRespInbound02Normalized", phase = "exit", requirement = "required", priority = 0, order = 23, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.entry.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "entry", requirement = "required", priority = 0, order = 24, allowed_resources = [], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.exit.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "exit", requirement = "required", priority = 0, order = 25, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.entry.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "entry", requirement = "required", priority = 0, order = 26, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.exit.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "exit", requirement = "required", priority = 0, order = 27, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.entry.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "entry", requirement = "required", priority = 0, order = 28, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "exit", requirement = "required", priority = 0, order = 29, allowed_resources = [], forbidden_resources = [] },
]
"#;

const PROVIDER_KEY_ENV: &str = "V3_OBS_REPLAY_KEY";

fn temp_home(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-obs-replay-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// A real upstream failure: HTTP 503 with a provider-shaped error body. It also
/// echoes upstream request id headers so the row can be checked for real
/// external evidence rather than a synthesised value.
async fn failing_upstream(State(calls): State<Arc<AtomicU64>>) -> Response<Body> {
    calls.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("content-type", "application/json")
        .header("x-request-id", "upstream-obs-replay-1")
        .header("openai-request-id", "upstream-obs-replay-1")
        .body(Body::from(
            r#"{"error":{"message":"controlled upstream unavailable","type":"server_error","code":"controlled_unavailable"}}"#,
        ))
        .unwrap()
}

async fn start_failing_upstream() -> (String, Arc<AtomicU64>, tokio::sync::oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicU64::new(0));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(failing_upstream))
        .with_state(Arc::clone(&calls));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), calls, shutdown_tx)
}

fn config_source(server_port: u16, admin_port: u16, upstream_base_url: &str) -> String {
    format!(
        r#"
version = 3
{HUB_V1_TEST_DECLARATION}
[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]

[servers.main.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]

[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}

[providers.mock]
type = "responses"
base_url = "{upstream_base_url}"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{PROVIDER_KEY_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 2, cooldown_ms = 5000 }}
responses = {{ process = "chat", streaming = "always" }}

[providers.mock.models.test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text", "tools"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000

[debug]
log_console = false
snapshots = true
dry_run = true
retention = {{ raw_requests = 8, raw_responses = 8, events = 64 }}

[route_groups.default.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-test"] }}
targets = [{{ kind = "provider_model", provider = "mock", model = "test", key = "key", priority = 1 }}]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "mock", model = "test", key = "key", priority = 1 }}]
"#
    )
}

async fn get_json(client: &reqwest::Client, url: &str) -> (reqwest::StatusCode, Value) {
    let response = client.get(url).send().await.unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    let value = serde_json::from_str(&body)
        .unwrap_or_else(|error| panic!("{url} did not return JSON ({status}): {error}\n{body}"));
    (status, value)
}

fn chain_node<'row>(chain: &'row Value, node: &str) -> &'row Value {
    chain
        .as_array()
        .expect("error_chain is an array")
        .iter()
        .find(|entry| entry["node"] == node)
        .unwrap_or_else(|| panic!("error_chain is missing {node}"))
}

fn artifact_files(body: &Value) -> &Vec<Value> {
    body["files"].as_array().expect("files is an array")
}

#[tokio::test]
async fn failing_provider_request_leaves_real_typed_truth_cooldown_and_artifacts() {
    let _guard = TEST_LOCK.lock().await;
    env::set_var(PROVIDER_KEY_ENV, "controlled-obs-replay-secret");
    let home = temp_home("replay");
    let previous_home = env::var_os("HOME");
    env::set_var("HOME", &home);

    let (upstream_base_url, upstream_calls, upstream_shutdown) = start_failing_upstream().await;
    let server_port = free_port();
    let admin_port = free_port();
    let config_path = home.join("config.v3.toml");
    fs::write(
        &config_path,
        config_source(server_port, admin_port, &upstream_base_url),
    )
    .unwrap();

    let snapshot = V3ConfigStore::new(&config_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let handle = spawn_v3_server_aggregate_with_admin(
        snapshot.manifest,
        snapshot.admin_webui,
        Some(config_path),
    )
    .await
    .unwrap();
    let server_addr = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "main")
        .expect("aggregate exposes the configured server listener")
        .addr;
    let admin_addr = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "admin_webui")
        .expect("aggregate exposes the admin webui listener")
        .addr;

    let client = reqwest::Client::new();
    let request_started_ms = now_epoch_ms();
    let response = client
        .post(format!("http://{server_addr}/v1/responses"))
        .json(&json!({
            "model": "client-test",
            "input": "observability replay probe",
            "stream": false
        }))
        .send()
        .await;

    // 1. The failure is real: the provider was contacted exactly once, and the
    //    client observes a transport break. The provider's own status and body
    //    are provider-private evidence and never reach the client.
    assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);
    assert!(
        response.is_err(),
        "a provider HTTP failure must not fabricate a client HTTP response"
    );
    let client_status = "transport_break";

    // 2. The runtime wrote a row for this request; read it back over HTTP.
    let list_url = format!("http://{admin_addr}/api/observability/records?range=all&page_size=50");
    let deadline = Instant::now() + Duration::from_secs(20);
    let (request_key, list_row) = loop {
        let (status, body) = get_json(&client, &list_url).await;
        assert_eq!(status, reqwest::StatusCode::OK, "records list: {body}");
        if let Some(row) = body["records"].as_array().and_then(|rows| rows.first()) {
            break (
                row["request_key"]
                    .as_str()
                    .expect("request_key")
                    .to_string(),
                row.clone(),
            );
        }
        assert!(
            Instant::now() < deadline,
            "no observability row appeared within 20s"
        );
        sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(list_row["result"], "error");
    assert_eq!(list_row["failed_attempts"], 1);
    // The merged row carries the projected internal status (a provider network
    // failure projects 502); the real external 503 stays on the attempt row and
    // in `observed_error.external_error_status`, both asserted below.
    assert_eq!(list_row["meta"]["provider_status"], 502);

    let (detail_status, detail) = get_json(
        &client,
        &format!("http://{admin_addr}/api/observability/records/{request_key}"),
    )
    .await;
    assert_eq!(detail_status, reqwest::StatusCode::OK);

    // 3. The typed Error chain is real, complete, and ordered.
    let chain = detail["error_chain"].clone();
    let nodes: Vec<&str> = chain
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["node"].as_str().unwrap())
        .collect();
    assert_eq!(
        nodes,
        vec![
            "V3Error01SourceRaised",
            "V3Error02Classified",
            "V3Error03TargetLocalAction",
            "V3Error04TargetExhaustionDecision",
            "V3Error05ExecutionDecision",
            "V3Error06ClientProjected",
        ],
        "error_chain must always carry all six nodes in order"
    );
    assert_eq!(
        chain_node(&chain, "V3Error01SourceRaised")["state"],
        "raised"
    );
    assert_eq!(
        chain_node(&chain, "V3Error06ClientProjected")["state"],
        "observed"
    );
    assert_eq!(
        chain_node(&chain, "V3Error06ClientProjected")["code"],
        "502",
        "V3Error06ClientProjected must carry the projected internal status"
    );
    let reached = chain
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["state"] != "not_reached")
        .count();
    assert_eq!(reached, 6, "every node was really reached: {chain}");

    // The chain came from the Error projection lane, not from the per-attempt
    // snapshot: the attempt row's own chain is empty. This is the negative
    // control for the assertion above — a constant chain could not differ.
    let attempts = detail["attempts"].as_array().expect("attempts is an array");
    assert_eq!(attempts.len(), 1, "one failed provider attempt");
    assert_eq!(attempts[0]["meta"]["provider_status"], 503);
    assert_eq!(
        attempts[0]["meta"]["observed_error"]["source"],
        "provider_attempt_failure"
    );
    assert_eq!(
        attempts[0]["meta"]["observed_error"]["chain"],
        json!([]),
        "the per-attempt snapshot carries no chain; the six-node chain comes from the Error projection"
    );

    // 4. Real external truth and the real health effect, straight from the row.
    let observed = &detail["row"]["meta"]["observed_error"];
    assert_eq!(observed["source"], "error06_projection_not_exposed");
    assert_eq!(observed["external_error_code"], "server_error");
    assert_eq!(observed["external_error_status"], 503);
    assert_eq!(observed["failure_count"], 1);
    // HTTP 503 retains its declared first-failure threshold; only ordinary 429
    // uses the three-consecutive-failure rule.
    assert_eq!(observed["health_state"], "cooldown");
    assert_eq!(observed["action"], "terminal_route_and_default_exhausted");
    assert_eq!(observed["attempt_index"], 1);
    assert!(
        observed["cooldown_until_ms"].as_u64().unwrap() > request_started_ms,
        "the real HTTP 503 failure must schedule exact-identity recovery: {observed}"
    );
    assert_eq!(
        detail["observed_error_source"],
        "error06_projection_not_exposed"
    );

    // 5. `raw_artifact_ref` points at a directory that really exists on disk,
    //    in the runtime's own sample layout.
    let artifact_ref = detail["row"]["raw_artifact_ref"]
        .as_str()
        .expect("raw_artifact_ref must resolve for a captured failure")
        .to_string();
    let artifact_dir = Path::new(&artifact_ref);
    assert!(
        artifact_dir.is_dir(),
        "raw_artifact_ref must point at a real directory: {artifact_ref}"
    );
    assert_eq!(
        detail["row"]["meta"]["request_id"],
        json!(request_id_of(&request_key))
    );
    let request_id = request_id_of(&request_key);
    assert_eq!(
        artifact_dir.file_name().unwrap().to_string_lossy(),
        request_id
    );
    assert_eq!(
        artifact_dir
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy(),
        server_port.to_string()
    );
    assert_eq!(
        artifact_dir
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy(),
        "ports"
    );
    assert_eq!(
        artifact_dir
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy(),
        "openai-responses"
    );
    assert!(
        artifact_dir.starts_with(home.join(".rcc").join("codex-samples")),
        "the reference must live under the runtime's samples root: {artifact_ref}"
    );

    // 6. The artifacts endpoint lists the real files with their real sizes.
    //    Evidence is persisted through the serialized sample worker, so the
    //    listing can be observed while a file is still being written. Wait for a
    //    stable listing, then still require exact size equality against disk.
    let artifacts_deadline = Instant::now() + Duration::from_secs(20);
    let (files, checked) = loop {
        let (artifacts_status, artifacts) = get_json(
            &client,
            &format!(
                "http://{admin_addr}/api/observability/artifacts?port={server_port}&request_id={request_id}"
            ),
        )
        .await;
        assert_eq!(artifacts_status, reqwest::StatusCode::OK);
        assert_eq!(artifacts["dir_exists"], true);
        let files = artifact_files(&artifacts).clone();
        assert!(
            !files.is_empty(),
            "a captured failure must leave real artifacts"
        );
        let mut checked = Vec::new();
        let mut stable = true;
        for entry in &files {
            let name = entry["file"].as_str().unwrap();
            let reported = entry["size_bytes"].as_u64().unwrap();
            let on_disk = match fs::metadata(artifact_dir.join(name)) {
                Ok(metadata) => metadata,
                Err(_) => {
                    stable = false;
                    break;
                }
            };
            assert!(on_disk.is_file());
            assert!(reported > 0, "{name} must have a real non-zero size");
            if on_disk.len() != reported {
                stable = false;
                break;
            }
            checked.push(format!("{name}={reported}"));
        }
        if stable {
            break (files, checked);
        }
        assert!(
            Instant::now() < artifacts_deadline,
            "artifact sizes must stabilize against the files on disk"
        );
        sleep(Duration::from_millis(25)).await;
    };
    assert!(
        files.iter().any(|entry| entry["file"] == "error.json"),
        "the failure evidence must include error.json"
    );

    // 7. The first HTTP 503 must cool its exact provider/model/key identity.
    let (pool_status, pool) = get_json(
        &client,
        &format!("http://{admin_addr}/api/observability/cooldown-pool"),
    )
    .await;
    assert_eq!(pool_status, reqwest::StatusCode::OK);
    let entries = pool["listeners"][0]["entries"]
        .as_array()
        .expect("cooldown pool entries");
    let first_cooled = entries
        .iter()
        .find(|entry| entry["provider_id"] == "mock")
        .unwrap_or_else(|| panic!("the first HTTP 503 must cool its exact identity: {pool}"));
    assert_eq!(first_cooled["auth_alias"], "key");
    assert_eq!(first_cooled["model_id"], "test");

    // 8. A later business request cannot send another attempt to the cooled key.
    let response = client
        .post(format!("http://{server_addr}/v1/responses"))
        .json(&json!({
            "model": "client-test",
            "input": "observability replay probe",
            "stream": false
        }))
        .send()
        .await;
    assert!(
        response.is_err(),
        "a cooled identity must not fabricate a client HTTP response"
    );
    assert_eq!(upstream_calls.load(Ordering::SeqCst), 1);

    let (pool_status, pool) = get_json(
        &client,
        &format!("http://{admin_addr}/api/observability/cooldown-pool"),
    )
    .await;
    assert_eq!(pool_status, reqwest::StatusCode::OK);
    let entries = pool["listeners"][0]["entries"]
        .as_array()
        .expect("cooldown pool entries");
    let cooled = entries
        .iter()
        .find(|entry| entry["provider_id"] == "mock")
        .unwrap_or_else(|| {
            panic!("provider mock must remain cooled after the blocked request: {pool}")
        });
    assert_eq!(cooled["auth_alias"], "key");
    assert_eq!(cooled["model_id"], "test");
    assert_eq!(cooled["state"], "blocked");
    let pool_until_ms = cooled["until_ms"].as_u64().expect("until_ms");
    assert!(
        pool_until_ms > request_started_ms,
        "the pool must still be cooling: {pool_until_ms} vs {request_started_ms}"
    );
    assert!(cooled["remaining_ms"].as_i64().unwrap() > 0);

    // 9. Negative control: an unrelated request key is honestly absent.
    let (missing_status, missing) = get_json(
        &client,
        &format!("http://{admin_addr}/api/observability/records/{server_port}:not-a-real-request"),
    )
    .await;
    assert_eq!(missing_status, reqwest::StatusCode::NOT_FOUND);
    assert_eq!(missing, json!({"error":"request_not_found"}));

    // Real captured values, so the evidence is inspectable without a debugger.
    eprintln!("[replay] request_key={request_key}");
    eprintln!("[replay] client_status={client_status} upstream_calls=1");
    eprintln!("[replay] error_chain={chain}");
    eprintln!(
        "[replay] observed_error_source={} health_action={} error_class={}",
        detail["observed_error_source"], observed["health_action"], observed["error_class"]
    );
    eprintln!("[replay] observed_error={observed}");
    eprintln!("[replay] raw_artifact_ref={artifact_ref}");
    eprintln!("[replay] artifacts={checked:?}");
    eprintln!("[replay] cooldown_entry={cooled}");

    handle.shutdown().await;
    upstream_shutdown.send(()).unwrap();
    env::remove_var(PROVIDER_KEY_ENV);
    match previous_home {
        Some(previous) => env::set_var("HOME", previous),
        None => env::remove_var("HOME"),
    }
    let _ = fs::remove_dir_all(&home);
}

fn request_id_of(request_key: &str) -> String {
    request_key
        .split_once(':')
        .expect("request_key is <port>:<request_id>")
        .1
        .to_string()
}
