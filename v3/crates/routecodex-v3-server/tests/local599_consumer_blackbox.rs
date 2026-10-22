//! Local 599 black-box consumer fixture for issue b878f6c.
//!
//! Contract under test: an upstream HTTP 200 followed by a real failure in the
//! local response-processing path must enter the typed Error chain as an
//! internal Response/599 event and terminate the request transport. It must
//! never reach the client as an HTTP error status, an SSE error payload, or a
//! fabricated empty success; and a local 599 must not be treated as a provider
//! HTTP failure, so provider health must stay neutral. The upstream 200 belongs
//! to the provider HTTP evidence channel while the 599 belongs to the internal
//! lane: both facts must survive separately in production typed resources.
//!
//! This fixture composes only existing public and production entry points:
//! `ProviderResponsesTransport` performs the real HTTP round trip, the shared
//! transport handoff broker is the real control resource that rejects an
//! illegal attempt-state transition, and the public Runtime
//! `execute_v3_responses_relay_runtime_with_transport_health`
//! is the consumer entry. Nothing mocks the Error exit and no product fault
//! switch or injection framework is used. The only test-owned component is a
//! single transport wrapper that drives one genuine broker transition per
//! attempt while keeping the provider request, attempt identity, upstream
//! response head and body untouched.
//!
//! Chain asserted here:
//!   real HTTP 200 -> real broker rejection Err -> public Runtime Error chain
//!   -> internal Response/599 + Error06 terminal + typed NoResponse disposition
//!   -> production Server projection terminates the client transport with no
//!      error payload and no empty success.
//!
//! Run:
//! CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server \
//!   --test local599_consumer_blackbox -- --nocapture

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::{
    V3ProviderFailureSessionScope, V3ProviderTerminalDisposition, V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    ProviderResponsesTransport, ResponsesTransport, V3ProviderError,
    V3ProviderInternalTransportLane, V3ProviderResp14Raw, V3ProviderResponseBody,
    V3ProviderSseStream, V3ProviderTransportAttemptBroker, V3ProviderTransportAttemptKey,
    V3ProviderTransportAttemptState,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_transport_health,
    V3ResponsesRelayClientBody, V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};

const KEY_ENV: &str = "V3_LOCAL599_TEST_KEY";
const PROVIDER_ID: &str = "local599";
const MODEL_ID: &str = "wire-test";
const PIPELINE_ID: &str = "local599-pipeline";
const RUNTIME_GENERATION: u64 = 1;
const SERVER_PORT: u16 = 24601;

/// How one provider attempt behaves inside the test-owned transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptMode {
    /// The real provider response is forwarded untouched.
    Pass,
    Empty,
    RequestScopeFailure,
    /// The real provider response is consumed, then one genuine illegal broker
    /// transition turns it into a real Response-lane Error for the runtime.
    HandoffFailure,
}

#[derive(Debug, Clone)]
struct AttemptReceipt {
    mode: AttemptMode,
    request_id: String,
    provider_id: String,
    /// Upstream HTTP status seen on the real provider response head.
    provider_status: Option<u16>,
    /// Bytes the upstream actually returned on the wire.
    upstream_bytes: usize,
    /// The real error this transport produced, if any.
    error: Option<String>,
    /// The real broker attempt identity for this provider send.
    attempt_key: Option<V3ProviderTransportAttemptKey>,
    /// Real broker state observed immediately before the illegal transition.
    state_before: Option<V3ProviderTransportAttemptState>,
    /// The real illegal transition and the real rejection text.
    illegal_transition: Option<(V3ProviderTransportAttemptState, String)>,
    /// Real broker state after the attempt was released again.
    state_after_release: Option<V3ProviderTransportAttemptState>,
}

struct UpstreamRecorder {
    response_body: String,
    requests: AtomicUsize,
    statuses: Mutex<Vec<u16>>,
    bodies: Mutex<Vec<Vec<u8>>>,
}

impl UpstreamRecorder {
    fn new(response_body: String) -> Self {
        Self {
            response_body,
            requests: AtomicUsize::new(0),
            statuses: Mutex::new(Vec::new()),
            bodies: Mutex::new(Vec::new()),
        }
    }

    fn record(&self, status: StatusCode, body: String) {
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.statuses.lock().unwrap().push(status.as_u16());
        self.bodies.lock().unwrap().push(body.into_bytes());
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }

    fn statuses(&self) -> Vec<u16> {
        self.statuses.lock().unwrap().clone()
    }

    fn first_body(&self) -> Vec<u8> {
        self.bodies
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_default()
    }
}

/// Single test-owned ResponsesTransport delegating the real HTTP round trip to
/// the official transport, optionally failing the attempt through one genuine
/// illegal transition on the real shared handoff broker.
struct Local599Transport {
    inner: ProviderResponsesTransport,
    /// The real shared handoff control resource carried by `inner`.
    broker: V3ProviderTransportAttemptBroker,
    mode: AttemptMode,
    upstream: Arc<UpstreamRecorder>,
    receipts: Arc<Mutex<Vec<AttemptReceipt>>>,
}

#[async_trait]
impl ResponsesTransport for Local599Transport {
    async fn send(
        &self,
        request: routecodex_v3_provider_responses::V3Transport13ResponsesRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        // This public library consumer supplies its own typed runtime scope.
        // The scope never enters the wire request or business payload.
        let request_id = request.request_id().to_string();
        let request = request
            .with_handoff_scope(
                routecodex_v3_provider_responses::V3ProviderTransportHandoffScope {
                    pipeline_id: if self.mode == AttemptMode::RequestScopeFailure {
                        String::new()
                    } else {
                        PIPELINE_ID.to_string()
                    },
                    server_id: "local599-consumer".to_string(),
                    port: SERVER_PORT,
                    session_scope: request_id.clone(),
                    runtime_generation: RUNTIME_GENERATION,
                },
            )
            .map_err(|reason| V3ProviderError::InternalTransport {
                request_id: request_id.clone(),
                provider_id: PROVIDER_ID.to_string(),
                lane: V3ProviderInternalTransportLane::Request,
                reason,
            })?;
        let raw = self.inner.send(request).await?;
        let status = raw.status();
        let headers = raw.headers().to_vec();
        let compatibility_profile = raw.compatibility_profile().map(ToOwned::to_owned);
        let sse_first_frame_timeout_ms = raw.sse_first_frame_timeout_ms();
        let key = live_attempt_key(&self.broker, &request_id, PROVIDER_ID);
        let state_before = key.as_ref().and_then(|key| self.broker.state(key));
        let upstream_bytes = self.upstream.first_body().len();

        if self.mode != AttemptMode::HandoffFailure {
            self.receipts.lock().unwrap().push(AttemptReceipt {
                mode: self.mode,
                request_id,
                provider_id: PROVIDER_ID.to_string(),
                provider_status: Some(status),
                upstream_bytes,
                error: None,
                attempt_key: key,
                state_before,
                illegal_transition: None,
                state_after_release: None,
            });
            return Ok(raw);
        }

        let V3ProviderResponseBody::Sse(upstream_stream) = raw.into_body() else {
            return Err(V3ProviderError::InternalTransport {
                request_id: request_id.clone(),
                provider_id: PROVIDER_ID.to_string(),
                lane: V3ProviderInternalTransportLane::Response,
                reason: "local599 fixture expected the controlled upstream to return SSE"
                    .to_string(),
            });
        };
        let broker = self.broker.clone();
        let receipts = self.receipts.clone();
        let failure_request_id = request_id.clone();
        let failure_stream: V3ProviderSseStream = Box::pin(futures_util::stream::once(
            async move {
                let _upstream_stream = upstream_stream;
                let live_key = key
                    .as_ref()
                    .expect("real provider attempt must be registered");
                let from = broker.state(live_key).expect("real provider attempt state");
                let to = V3ProviderTransportAttemptState::Streaming;
                // Terminal is reachable from the real Streaming attempt
                // head. Reopening that terminal attempt as Streaming is
                // genuinely illegal and is rejected by the shared broker.
                broker
                    .transition(live_key, V3ProviderTransportAttemptState::Terminal)
                    .expect("fixture must close an actual provider attempt");
                let rejection = broker
                    .transition(live_key, to)
                    .expect_err("a terminal attempt cannot reopen");
                let state_after = broker.state(live_key);
                let _ = broker.remove(live_key);
                let error = V3ProviderError::InternalTransport {
                request_id: failure_request_id.clone(),
                provider_id: PROVIDER_ID.to_string(),
                lane: V3ProviderInternalTransportLane::Response,
                reason: format!("local599 controlled broker transition {from:?} -> {to:?} was rejected by the shared handoff broker: {rejection}"),
            };
                receipts.lock().unwrap().push(AttemptReceipt {
                    mode: AttemptMode::HandoffFailure,
                    request_id: failure_request_id,
                    provider_id: PROVIDER_ID.to_string(),
                    provider_status: Some(status),
                    upstream_bytes,
                    error: Some(error.to_string()),
                    attempt_key: key,
                    state_before,
                    illegal_transition: Some((from, error.to_string())),
                    state_after_release: state_after,
                });
                Err::<Vec<u8>, V3ProviderError>(error)
            },
        ));
        let raw = V3ProviderResp14Raw::from_sse(
            request_id,
            PROVIDER_ID.to_string(),
            status,
            headers,
            failure_stream,
        )
        .with_compatibility_profile(compatibility_profile)
        .with_sse_first_frame_timeout_ms(sse_first_frame_timeout_ms);
        Ok(raw)
    }
}

fn live_attempt_key(
    broker: &V3ProviderTransportAttemptBroker,
    request_id: &str,
    provider_id: &str,
) -> Option<V3ProviderTransportAttemptKey> {
    broker
        .checkpoints()
        .into_iter()
        .filter(|checkpoint| {
            checkpoint.key.request_id == request_id
                && checkpoint.key.provider_id == provider_id
                && matches!(
                    checkpoint.state,
                    V3ProviderTransportAttemptState::Connecting
                        | V3ProviderTransportAttemptState::Streaming
                        | V3ProviderTransportAttemptState::Detached
                )
        })
        .map(|checkpoint| checkpoint.key)
        .max_by_key(|key| key.attempt_id)
}

fn build_local599_transport(
    mode: AttemptMode,
    upstream: Arc<UpstreamRecorder>,
) -> Local599Transport {
    let inner = ProviderResponsesTransport::default();
    Local599Transport {
        broker: inner.transport_handoff_broker(),
        inner,
        mode,
        upstream,
        receipts: Arc::new(Mutex::new(Vec::new())),
    }
}

/// Responses-shaped non-empty SSE payload the controlled upstream really sends.
fn responses_text_sse(text: &str) -> String {
    let response = json!({
        "id": "resp_local599_success",
        "object": "response",
        "status": "completed",
        "model": MODEL_ID,
        "output": [{
            "id": "msg_local599_success",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}]
        }]
    });
    format!(
        "event: response.created\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
        json!({"type": "response.created", "response": {"id": response["id"], "model": MODEL_ID}}),
        json!({"type": "response.completed", "response": response})
    )
}

async fn controlled_upstream(
    State(state): State<Arc<UpstreamRecorder>>,
    _body: axum::extract::Json<Value>,
) -> Response<Body> {
    state.record(StatusCode::OK, state.response_body.clone());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(state.response_body.clone()))
        .expect("valid controlled upstream response")
}

/// Start the test-owned controlled upstream on a loopback socket and return its
/// base URL, recorder and shutdown sender. Nothing writes the real HOME, the
/// shared sample store, or any production configuration.
async fn start_controlled_upstream(
    response_body: String,
) -> (
    String,
    Arc<UpstreamRecorder>,
    tokio::sync::oneshot::Sender<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback upstream socket");
    let addr = listener.local_addr().expect("loopback upstream address");
    let upstream = Arc::new(UpstreamRecorder::new(response_body));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .with_state(upstream.clone());
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("serve controlled upstream");
    });
    (format!("http://{addr}/v1"), upstream, shutdown_tx)
}

fn local599_manifest(
    base_url: &str,
    health_enabled: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = {SERVER_PORT}
routing_group = "local599-group"
endpoints = ["responses"]
[servers.a.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client"]
allowed_transports = ["json", "sse"]
[providers.{PROVIDER_ID}]
type = "responses"
base_url = "{base_url}"
default_model = "{MODEL_ID}"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{KEY_ENV}" }}, {{ alias = "key2", env = "{KEY_ENV}" }}] }}
health = {{ enabled = {health_enabled}, failure_threshold = 3, cooldown_ms = 60000 }}
responses = {{ process = "relay", streaming = "always" }}
[providers.{PROVIDER_ID}.models.{MODEL_ID}]
wire_name = "{MODEL_ID}"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.local599-group.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{PROVIDER_ID}", model = "{MODEL_ID}", key = "key1", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source).expect("local599 authoring"),
    )
    .expect("local599 manifest")
}

fn local599_input(request_id: &str) -> V3ResponsesRelayRuntimeInput {
    V3ResponsesRelayRuntimeInput {
        server_id: "a".to_string(),
        failure_session_scope: V3ProviderFailureSessionScope::new(
            "local599-server",
            "local599-group",
            request_id,
        )
        .expect("local599 failure session scope")
        .with_transport_handoff_scope(PIPELINE_ID, SERVER_PORT, RUNTIME_GENERATION)
        .expect("local599 transport handoff scope"),
        request_id: request_id.to_string(),
        payload: json!({
            "model": MODEL_ID,
            "input": "local599 black box",
            "stream": true
        }),
    }
}

fn local599_health(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> V3ResponsesRelayProviderHealthHandle {
    V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(manifest)
}

fn health_snapshot(handle: &V3ResponsesRelayProviderHealthHandle) -> Vec<Value> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    handle
        .store()
        .cooldown_entries(now_ms as u64)
        .into_iter()
        .map(|entry| {
            json!({
                "provider_id": entry.provider_id,
                "auth_alias": entry.auth_alias,
                "model_id": entry.model_id,
                "state": entry.state,
                "reason": entry.reason,
                "failure_count": entry.failure_count,
            })
        })
        .collect()
}

async fn run_local599_case(
    mode: AttemptMode,
    request_id: &str,
) -> (
    routecodex_v3_runtime::V3ResponsesRelayRuntimeOutput,
    Arc<UpstreamRecorder>,
    V3ResponsesRelayProviderHealthHandle,
    Local599Transport,
    tokio::sync::oneshot::Sender<()>,
) {
    std::env::set_var(KEY_ENV, "local599-test-secret");
    let body = if mode == AttemptMode::Empty {
        format!(
            "event: response.completed\ndata: {}\n\n",
            json!({"type":"response.completed", "response":{"id":"empty", "status":"completed", "output":[]}})
        )
    } else {
        responses_text_sse("local599 controlled response")
    };
    let (base_url, upstream, shutdown) = start_controlled_upstream(body).await;
    let manifest = local599_manifest(&base_url, true);
    let transport = build_local599_transport(mode, upstream.clone());
    let health = local599_health(&manifest);
    let output = execute_v3_responses_relay_runtime_with_transport_health(
        &manifest,
        local599_input(request_id),
        &transport,
        &health,
    )
    .await
    .expect("local599 runtime must return a typed output");
    (output, upstream, health, transport, shutdown)
}

pub(crate) async fn output_for_server(
    fail: bool,
) -> routecodex_v3_runtime::V3ResponsesRelayRuntimeOutput {
    let mode = if fail {
        AttemptMode::HandoffFailure
    } else {
        AttemptMode::Pass
    };
    let (output, upstream, health, _transport, shutdown) =
        run_local599_case(mode, "req-local599-server").await;
    assert_eq!(upstream.requests(), 1);
    assert_eq!(upstream.statuses(), vec![200]);
    assert_eq!(output.status, if fail { 599 } else { 200 });
    assert_eq!(
        output.observability.as_ref().unwrap().provider_status,
        Some(200)
    );
    assert!(health_snapshot(&health).is_empty());
    let _ = shutdown.send(());
    output
}

#[tokio::test]
async fn local599_handoff_positive_control() {
    let (output, upstream, health, transport, shutdown) =
        run_local599_case(AttemptMode::Pass, "req-local599-pass").await;

    assert_eq!(
        upstream.requests(),
        1,
        "positive control must send one real HTTP attempt"
    );
    assert_eq!(upstream.statuses(), vec![200]);
    assert_eq!(
        output.status, 200,
        "real non-empty business must stay successful"
    );
    assert!(
        output.error_chain.is_none(),
        "positive control must not enter the Error chain: {:?}",
        output.error_chain
    );
    assert!(
        matches!(&output.client_body, V3ResponsesRelayClientBody::Sse(_)),
        "positive control must return the real SSE business response"
    );
    let observability = output
        .observability
        .as_ref()
        .expect("positive control must carry observability");
    assert_eq!(observability.provider_status, Some(200));
    assert!(
        health_snapshot(&health).is_empty(),
        "successful real business must not create cooldown health entries"
    );

    let receipts = transport.receipts.lock().unwrap();
    assert_eq!(
        receipts.len(),
        1,
        "one real provider attempt must produce one receipt"
    );
    assert_eq!(receipts[0].provider_status, Some(200));
    assert!(
        receipts[0].upstream_bytes > 0,
        "the real upstream body must be non-empty"
    );
    assert!(receipts[0].error.is_none());
    drop(receipts);
    let _ = shutdown.send(());
}

#[tokio::test]
async fn local599_real_transport_handoff_failure() {
    let (output, upstream, health, transport, shutdown) =
        run_local599_case(AttemptMode::HandoffFailure, "req-local599-fail").await;

    assert_eq!(
        upstream.requests(),
        1,
        "failure case must send one real HTTP attempt"
    );
    assert_eq!(upstream.statuses(), vec![200]);

    let provider_status = output
        .observability
        .as_ref()
        .and_then(|observability| observability.provider_status);
    let disposition = output.terminal_disposition;
    let error_chain = output.error_chain.clone();
    let receipts = transport.receipts.lock().unwrap();
    let receipt = receipts.first().cloned();
    let receipt_error = receipt
        .as_ref()
        .and_then(|receipt| receipt.error.as_ref().map(ToString::to_string));
    let illegal_transition = receipt
        .as_ref()
        .and_then(|receipt| receipt.illegal_transition.clone());
    eprintln!(
        "local599 failure facts: upstream_requests={} upstream_statuses={:?} output.status={} \
         observability.provider_status={:?} terminal_disposition={:?} error_chain={:?} \
         receipt_status={:?} receipt_error={:?} illegal_transition={:?}",
        upstream.requests(),
        upstream.statuses(),
        output.status,
        provider_status,
        disposition,
        error_chain,
        receipt.as_ref().and_then(|receipt| receipt.provider_status),
        receipt_error,
        illegal_transition
    );

    assert_eq!(
        output.status, 599,
        "local response-processing failure must project the internal 599 status"
    );
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice()),
        "local 599 must traverse the typed Error01..Error06 chain"
    );
    assert!(
        provider_status == Some(200),
        "production observability must preserve the actual upstream HTTP 200 separately from the internal 599; got {provider_status:?}"
    );
    assert_eq!(
        disposition,
        Some(V3ProviderTerminalDisposition::NoResponse),
        "the public runtime must expose a terminal no-response disposition for the local 599"
    );
    assert!(
        health_snapshot(&health).is_empty(),
        "a local 599 must not be recorded as a provider HTTP health failure"
    );
    assert_eq!(
        receipts.len(),
        1,
        "one real provider attempt must produce one receipt"
    );
    assert_eq!(
        receipt.as_ref().and_then(|receipt| receipt.provider_status),
        Some(200)
    );
    assert!(
        receipt
            .as_ref()
            .and_then(|receipt| receipt.error.as_ref())
            .is_some_and(|error| error.contains("rejected by the shared handoff broker")),
        "the fixture must produce a real InternalTransport(Response) error"
    );
    assert!(
        illegal_transition.is_some(),
        "the error must come from a real broker transition rejection"
    );
    drop(receipts);
    let _ = shutdown.send(());
}

#[tokio::test]
async fn empty_http200_attempt_is_typed502_without_last_candidate_health_mutation() {
    let (output, upstream, health, _transport, shutdown) =
        run_local599_case(AttemptMode::Empty, "req-empty-typed502").await;
    assert_eq!(upstream.statuses(), vec![200]);
    assert_eq!(upstream.requests(), 1);
    assert_eq!(output.status, 502);
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
    assert_eq!(
        output.observability.as_ref().unwrap().provider_status,
        Some(200)
    );
    assert!(output.terminal_disposition.is_some());
    let entries = health_snapshot(&health);
    assert!(
        entries.is_empty(),
        "the last candidate must not acquire cooldown: {entries:?}"
    );
    let _ = shutdown.send(());
}

#[tokio::test]
async fn request_scope_failure_is_typed598_without_provider_side_effects() {
    let (output, upstream, health, _transport, shutdown) =
        run_local599_case(AttemptMode::RequestScopeFailure, "req-local598").await;
    assert_eq!(upstream.requests(), 0);
    assert!(upstream.statuses().is_empty());
    assert_eq!(output.status, 598);
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
    assert_eq!(output.observability.as_ref().unwrap().provider_status, None);
    assert_eq!(
        output.terminal_disposition,
        Some(V3ProviderTerminalDisposition::NoResponse)
    );
    assert!(health_snapshot(&health).is_empty());
    let _ = shutdown.send(());
}
