use async_trait::async_trait;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw as build_v3_server_03_http_request_raw_with_scope,
    execute_v3_responses_direct_runtime_kernel_with_continuation, register_responses_direct_hooks,
    V3ClientBody, V3ResponsesDirectContinuationScope, V3ResponsesDirectContinuationState,
};
use serde_json::{json, Value};
use std::time::Duration;

fn request(request_id: &str, body: Value) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    let failure_session_scope =
        V3ProviderFailureSessionScope::new("s", "test-group", format!("test-session:{request_id}"))
            .expect("test provider failure session scope")
            .with_transport_handoff_scope("test-pipeline", 5555, 1)
            .expect("test provider transport handoff scope");
    let mut raw = build_v3_server_03_http_request_raw_with_scope(
        "s".into(),
        failure_session_scope,
        request_id.into(),
        format!("exec-{request_id}"),
        "POST".into(),
        "/v1/responses".into(),
        body,
    );
    raw.port = Some(5555);
    raw.pipeline_id = Some("test-pipeline".to_string());
    raw
}

fn scope(routing_group: &str) -> V3ResponsesDirectContinuationScope {
    V3ResponsesDirectContinuationScope::responses(
        "/v1/responses",
        "session-a",
        "conversation-a",
        5555,
        routing_group,
    )
}

fn manifest(routing_group: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&format!(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 5555
routing_group = "{routing_group}"
endpoints = ["responses"]
[servers.s.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = {{ allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }}
attempt_store = {{}}
[providers.p]
enabled = true
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "m"
auth = {{ type = "api_key", entries = [{{ alias = "a", env = "TEST_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 3, cooldown_ms = 900000 }}
responses = {{ process = "direct", streaming = "always", transport = "http" }}
[providers.p.models.m]
wire_name = "wire-m"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.{routing_group}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "p", model = "m", key = "a", priority = 1 }}]
"#
        ))
        .expect("parse direct continuation fixture"),
    )
    .expect("compile direct continuation fixture")
}

struct DirectMalformedSseAttemptTransport;

#[async_trait]
impl ResponsesTransport for DirectMalformedSseAttemptTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![
                Ok(concat!(
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"response_id\":\"resp_failed_attempt_malformed\",\"delta\":\"partial\"}\n\n",
                )
                .as_bytes()
                .to_vec()),
                Ok(b"data: {malformed-json}\n\n".to_vec()),
            ])),
        ))
    }
}

struct DirectFailedTerminalSseAttemptTransport;

#[async_trait]
impl ResponsesTransport for DirectFailedTerminalSseAttemptTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![
                Ok(concat!(
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"response_id\":\"resp_failed_attempt_event\",\"delta\":\"partial\"}\n\n",
                )
                .as_bytes()
                .to_vec()),
                Ok(concat!(
                    "event: response.failed\n",
                    "data: {\"type\":\"response.failed\",\"response\":{\"id\":\"resp_failed_attempt_event\",\"status\":\"failed\",\"error\":{\"code\":\"HTTP_503\",\"message\":\"provider failed after delta\"}}}\n\n",
                )
                .as_bytes()
                .to_vec()),
            ])),
        ))
    }
}

struct DirectCompletedJsonTransport;

#[async_trait]
impl ResponsesTransport for DirectCompletedJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id": "resp_after_failed_attempt",
                "status": "completed",
                "output": [{"type": "output_text", "text": "recovered"}]
            }))
            .expect("serialize completed response"),
        ))
    }
}

struct DirectTerminalSseTransport;

#[async_trait]
impl ResponsesTransport for DirectTerminalSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".into(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream::iter(vec![Ok(concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_terminal_reset\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"done\"}]}}\n\n",
                "data: [DONE]\n\n",
            )
            .as_bytes()
            .to_vec())])),
        ))
    }
}

async fn assert_failed_attempt_does_not_poison_fresh_request<T: ResponsesTransport>(
    failed_transport: &T,
    failed_request_id: &str,
    fresh_request_id: &str,
    routing_group: &str,
) {
    let manifest = manifest(routing_group);
    let state = V3ResponsesDirectContinuationState::default();
    let first = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            failed_request_id,
            json!({"model": "gpt-5.5", "stream": true, "input": "stream"}),
        ),
        scope(routing_group),
        register_responses_direct_hooks(),
        failed_transport,
        1_000,
    )
    .await;
    assert_eq!(first.client_payload.status, 502, "{first:?}");
    let V3ClientBody::Json(body) = first.client_payload.body else {
        panic!("failed provider attempt must project JSON Error06")
    };
    assert_eq!(
        body,
        json!({"error": {"code": "network_error", "message": "network error"}})
    );
    assert_eq!(state.len().expect("continuation state lock"), 0);

    let second = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            fresh_request_id,
            json!({"model": "gpt-5.5", "input": "next"}),
        ),
        scope(routing_group),
        register_responses_direct_hooks(),
        &DirectCompletedJsonTransport,
        2_000,
    )
    .await;
    assert_eq!(second.client_payload.status, 200, "{second:?}");
}

#[tokio::test]
async fn malformed_sse_attempt_never_commits_partial_bytes_and_fresh_request_remains_independent() {
    assert_failed_attempt_does_not_poison_fresh_request(
        &DirectMalformedSseAttemptTransport,
        "req-direct-malformed-attempt",
        "req-direct-after-malformed-attempt",
        "direct_malformed_attempt",
    )
    .await;
}

#[tokio::test]
async fn failed_terminal_sse_attempt_never_commits_partial_bytes_and_exhausts_to_error06() {
    assert_failed_attempt_does_not_poison_fresh_request(
        &DirectFailedTerminalSseAttemptTransport,
        "req-direct-failed-terminal-attempt",
        "req-direct-after-failed-terminal-attempt",
        "direct_failed_terminal_attempt",
    )
    .await;
}

#[tokio::test]
async fn terminal_sse_success_seals_replay_without_blocking_a_fresh_request() {
    let routing_group = "direct_terminal_recovery";
    let manifest = manifest(routing_group);
    let state = V3ResponsesDirectContinuationState::default();
    let failed = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-direct-seed-active-gate",
            json!({"model": "gpt-5.5", "stream": true, "input": "seed"}),
        ),
        scope(routing_group),
        register_responses_direct_hooks(),
        &DirectMalformedSseAttemptTransport,
        1_000,
    )
    .await;
    assert_eq!(failed.client_payload.status, 502, "{failed:?}");

    let terminal = execute_v3_responses_direct_runtime_kernel_with_continuation(
        &state,
        &manifest,
        request(
            "req-direct-terminal-reset",
            json!({"model": "gpt-5.5", "stream": true, "input": "reset"}),
        ),
        scope(routing_group),
        register_responses_direct_hooks(),
        &DirectTerminalSseTransport,
        2_000,
    )
    .await;
    assert_eq!(terminal.client_payload.status, 200, "{terminal:?}");

    let waiting_manifest = manifest.clone();
    let waiting_state = V3ResponsesDirectContinuationState::default();
    let waiter = tokio::spawn(async move {
        execute_v3_responses_direct_runtime_kernel_with_continuation(
            &waiting_state,
            &waiting_manifest,
            request(
                "req-direct-released-by-terminal-success",
                json!({"model": "gpt-5.5", "input": "released"}),
            ),
            scope(routing_group),
            register_responses_direct_hooks(),
            &DirectCompletedJsonTransport,
            3_000,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        waiter.is_finished(),
        "fresh Direct request consumed an unrelated Error05 recovery lane"
    );
    let fresh = waiter.await.expect("fresh Direct request task panicked");
    assert_eq!(fresh.client_payload.status, 200, "{fresh:?}");

    let V3ClientBody::CommittedSse(mut body) = terminal.client_payload.body else {
        panic!("terminal Direct response must remain SSE")
    };
    let mut text = String::new();
    while let Some(chunk) = body.next().await {
        text.push_str(&String::from_utf8(chunk).expect("UTF-8"));
    }
    assert!(text.contains("response.completed"), "{text}");
    assert!(text.contains("[DONE]"), "{text}");
}
