use super::*;
use axum::Json;
use tokio::net::TcpListener;

const AUTH_ENV: &str = "ISSUE231_STALE_PROBE_KEY";
const AUTH_SECRET: &str = "issue231-owned-key";
const BUSINESS_FAILURE_MARKER: &str = "issue231 newer business generation marker";
const POOLED_MARKER: &str = "issue231 pooled candidate payload marker";
const HEALTHY_PAYLOAD: &str = "issue231 healthy candidate payload";

#[derive(Clone, Copy, PartialEq, Debug)]
enum StaleProbeOutcome {
    Success,
    Failure,
}

struct Peer {
    captures: Mutex<Vec<Value>>,
    probe_attempts: Mutex<u32>,
    probe_entered: Semaphore,
    probe_release: Semaphore,
    business_entered: Semaphore,
    business_release: Semaphore,
    first_probe_outcome: StaleProbeOutcome,
}

fn is_probe_body(body: &Value) -> bool {
    body.to_string().contains("ping; reply pong")
}

fn ok_json(body: Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn ok_responses(text: &str, stream: bool) -> Response<Body> {
    if stream {
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from(format!(
                "event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_issue231\",\"status\":\"in_progress\",\"output\":[]}}}}\n\nevent: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_issue231\",\"status\":\"completed\",\"output\":[{{\"type\":\"output_text\",\"text\":\"{text}\"}}],\"output_text\":\"{text}\"}}}}\n\ndata: [DONE]\n\n"
            )))
            .unwrap()
    } else {
        ok_json(json!({
            "id": "resp_issue231",
            "object": "response",
            "status": "completed",
            "model": "wire-healthy",
            "output": [{"type": "output_text", "text": text}],
            "output_text": text,
        }))
    }
}

fn failed(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"error": {"message": message}}).to_string(),
        ))
        .unwrap()
}

/// The cooled (preferred) provider. It serves exactly two behaviours:
/// the runtime cooldown rescue probe (probe body) and the pinned business
/// request. Both are held by semaphores so the test controls their order.
async fn cooled_provider(
    State(peer): State<Arc<Peer>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    assert_eq!(
        headers["authorization"].to_str().unwrap(),
        format!("Bearer {AUTH_SECRET}")
    );
    assert_eq!(body["model"], "wire-cooled");
    if is_probe_body(&body) {
        let attempt = {
            let mut attempts = peer.probe_attempts.lock().await;
            *attempts += 1;
            *attempts
        };
        peer.probe_entered.add_permits(1);
        peer.probe_release.acquire().await.unwrap().forget();
        return match (attempt, peer.first_probe_outcome) {
            (1, StaleProbeOutcome::Success) => ok_responses("pong", false),
            _ => failed(
                StatusCode::SERVICE_UNAVAILABLE,
                "issue231 owned probe failure",
            ),
        };
    }
    peer.captures.lock().await.push(body.clone());
    if body.to_string().contains(BUSINESS_FAILURE_MARKER) {
        peer.business_entered.add_permits(1);
        peer.business_release.acquire().await.unwrap().forget();
        return failed(
            StatusCode::SERVICE_UNAVAILABLE,
            "issue231 owned newer business failure",
        );
    }
    failed(
        StatusCode::SERVICE_UNAVAILABLE,
        "issue231 owned cooled failure",
    )
}

/// The healthy (later-tier) provider. It answers any business request with a
/// true business payload; the health probe gets a plain pong.
async fn healthy_provider(
    State(peer): State<Arc<Peer>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    assert_eq!(
        headers["authorization"].to_str().unwrap(),
        format!("Bearer {AUTH_SECRET}")
    );
    assert_eq!(body["model"], "wire-healthy");
    if is_probe_body(&body) {
        return ok_responses("pong", false);
    }
    let text = body.to_string();
    assert!(text.contains(POOLED_MARKER) || text.contains("issue231 healthy sibling"));
    peer.captures.lock().await.push(body.clone());
    ok_responses(
        HEALTHY_PAYLOAD,
        body.get("stream").and_then(Value::as_bool).unwrap_or(false),
    )
}

async fn spawn_provider_router(
    handler: axum::routing::MethodRouter<Arc<Peer>>,
    peer: Arc<Peer>,
) -> (String, oneshot::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", handler)
        .with_state(peer);
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), shutdown_tx)
}

fn issue231_manifest(
    port_a: u16,
    port_b: u16,
    cooled_base: &str,
    healthy_base: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION.replace(direct_binding, relay_binding);
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let source = format!(
        r#"
version = 3
{hub_v1_declaration}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses"]
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
endpoints = ["responses"]
{hub_v1_server_execution}
[providers.cooled]
type = "responses"
base_url = "{cooled_base}"
default_model = "wire-test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.cooled.models.wire-test]
wire_name = "wire-cooled"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[providers.healthy]
type = "responses"
base_url = "{healthy_base}"
default_model = "wire-test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.healthy.models.wire-test]
wire_name = "wire-healthy"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = false
snapshots = false
dry_run = false
retention = {{ raw_requests = 8, raw_responses = 8, events = 128 }}
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "cooled", model = "wire-test", key = "key", priority = 100 }},
  {{ kind = "provider_model", provider = "healthy", model = "wire-test", key = "key", priority = 1 }}
]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn cooldown_pool(client: &reqwest::Client, base: &str) -> Value {
    client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn cooled_probe_entry(pool: &Value) -> Option<&Value> {
    pool["entries"].as_array().and_then(|entries| {
        entries.iter().find(|entry| {
            entry["provider_id"] == "cooled"
                && entry["interface_id"] == "default"
                && entry["auth_alias"] == "key"
                && entry["model_id"] == "wire-test"
                && entry["kind"] == "probe"
        })
    })
}

fn assert_no_client_error_projection(label: &str, response: &reqwest::Response) {
    assert_ne!(
        response.status().as_u16(),
        598,
        "{label}: proxy must never answer the client with 598"
    );
}

/// Classify what the client really observes for a request that has no business
/// response. Only a transport break is valid. An empty HTTP success is also
/// a fabricated result and must fail the public regression.
#[derive(Debug)]
enum ClientOutcome {
    TransportBreak,
    Response(reqwest::Response),
}

async fn send_for_outcome(
    client: reqwest::Client,
    endpoint: String,
    model: &str,
    input: &str,
) -> ClientOutcome {
    match client
        .post(endpoint)
        .json(&json!({
            "model": model,
            "input": input,
            "stream": false
        }))
        .send()
        .await
    {
        Ok(response) => ClientOutcome::Response(response),
        Err(_) => ClientOutcome::TransportBreak,
    }
}
