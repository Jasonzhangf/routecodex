//! db1f482 regression: a truncated provider HTTP 200 body is a typed provider
//! transport failure. It must cool only the exact `provider.interface.auth.key.model`
//! identity and must not cool untried keys, other models, or other providers.

use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderAvailabilityReader, V3ProviderError, V3ProviderHttpFailure,
    V3ProviderResp14Raw, V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_health_and_retry_policy, V3ResponsesRelayClientBody,
    V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRetryPolicy,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

fn manifest(scope: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[servers.__SCOPE__.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}
[providers.limited]
type = "responses"
base_url = "http://limited.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "LIMITED_KEY" }] }
concurrency = { max_in_flight = 128, acquire_timeout_ms = 60000, stale_lease_ms = 300000 }
[providers.limited.models."gpt-5.5"]
wire_name = "gpt-5.5"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning"]
[providers.minimax]
type = "responses"
base_url = "http://minimax.invalid/v1"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MINIMAX_KEY" }] }
concurrency = { max_in_flight = 128, acquire_timeout_ms = 60000, stale_lease_ms = 300000 }
[providers.minimax.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
supports_streaming = true
supports_thinking = true
max_context_tokens = 1000000
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 2 },
  { kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 2 },
  { kind = "provider_model", provider = "minimax", model = "MiniMax-M3", key = "key1", priority = 1 }
]
"#;
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source.replace("__SCOPE__", scope)).unwrap(),
    )
    .unwrap()
}

/// Same provider as `manifest`, but with one eligible candidate. This forces the
/// failure policy into the last-candidate branch.
fn single_candidate_manifest(scope: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 5555
routing_group = "__SCOPE__"
endpoints = ["responses"]
[servers.__SCOPE__.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}
[providers.limited]
type = "responses"
base_url = "http://limited.invalid/v1"
default_model = "gpt-5.5"
auth = { type = "api_key", entries = [{ alias = "key1", env = "LIMITED_KEY" }] }
concurrency = { max_in_flight = 128, acquire_timeout_ms = 60000, stale_lease_ms = 300000 }
[providers.limited.models."gpt-5.5"]
wire_name = "gpt-5.5"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning"]
[route_groups.__SCOPE__.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 2 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "limited", model = "gpt-5.5", key = "key1", priority = 2 }
]
"#;
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&source.replace("__SCOPE__", scope)).unwrap(),
    )
    .unwrap()
}

struct TruncatedLimitedThenSuccessTransport {
    captures: Mutex<Vec<String>>,
    turn: AtomicUsize,
}

struct CompleteHttp502Transport;

#[async_trait]
impl ResponsesTransport for TruncatedLimitedThenSuccessTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push(request.provider_id().to_string());
        if request.provider_id() == "limited" {
            let _ = self.turn.fetch_add(1, Ordering::SeqCst);
            // A truncated HTTP 200 body: the head arrived (status 200), but the
            // body could not be read to completion.
            return Err(V3ProviderError::ResponseBodyUnreadable {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                status: 200,
                headers: vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                reason: "error decoding response body: connection closed while reading body"
                    .to_string(),
            });
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_minimax_ok",
                "status":"completed",
                "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"healthy secondary"}]}],
                "usage":{"input_tokens":11,"output_tokens":2,"total_tokens":13}
            }))
            .unwrap(),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for CompleteHttp502Transport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Err(V3ProviderError::HttpStatus {
            response: Box::new(V3ProviderHttpFailure {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                status: 502,
                headers: vec![],
                body: b"upstream gateway failure".to_vec(),
                body_read_failure: None,
            }),
        })
    }
}

#[tokio::test]
async fn truncated_http_200_cools_exact_identity_and_isolates_other_identities() {
    let server_id = "truncated_200_identity";
    let manifest = manifest(server_id);
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest);
    let transport = TruncatedLimitedThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
        turn: AtomicUsize::new(0),
    };
    let output = execute_v3_responses_relay_runtime_with_health_and_retry_policy(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "truncated-200-identity-session",
            )
            .expect("test provider failure session scope"),
            request_id: "req-truncated-200".into(),
            payload: json!({
                "model":"client-responses",
                "input":"truncated provider body",
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .expect("truncated primary must reselect into the healthy secondary");

    assert_eq!(output.status, 200);
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    let V3ResponsesRelayClientBody::Json(_) = output.client_body else {
        panic!("healthy secondary must project a JSON body");
    };
    let observability = output
        .observability
        .as_ref()
        .expect("console observability");
    assert_eq!(observability.provider_failure_events.len(), 1);
    let event = &observability.provider_failure_events[0];
    assert_eq!(event.provider_key, "limited:default:key1:gpt-5.5");
    assert_eq!(event.status, 502);
    assert_eq!(event.action, "switch_provider");
    assert_eq!(event.failure_count, 1);
    assert_eq!(event.health_state, "cooldown");
    assert!(event.cooldown_until_ms.is_some());

    let now = u64::MAX;
    assert!(
        !provider_health
            .store()
            .availability("limited", Some("key1"), Some("gpt-5.5"), now)
            .available,
        "the exact failed identity must be cooled"
    );
    assert!(
        provider_health
            .store()
            .availability("limited", Some("key1"), Some("other-model"), now)
            .available,
        "another model under the same provider and key must stay routable"
    );
    assert!(
        provider_health
            .store()
            .availability("limited", Some("other-key"), Some("gpt-5.5"), now)
            .available,
        "another key under the same provider and model must stay routable"
    );
    assert!(
        provider_health
            .store()
            .availability("minimax", Some("key1"), Some("MiniMax-M3"), now)
            .available,
        "the untried secondary provider must stay routable"
    );
}

/// A truncated HTTP 200 body stays health-neutral when the failed candidate is
/// the request's last eligible one. The last-candidate terminal boundary owns
/// every provider failure class and must not mutate provider health.
#[tokio::test]
async fn truncated_http_200_keeps_last_candidate_health_neutral() {
    let server_id = "truncated_200_last_candidate";
    let manifest = single_candidate_manifest(server_id);
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest);
    let transport = TruncatedLimitedThenSuccessTransport {
        captures: Mutex::new(Vec::new()),
        turn: AtomicUsize::new(0),
    };
    let output = execute_v3_responses_relay_runtime_with_health_and_retry_policy(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "truncated-200-last-candidate-session",
            )
            .expect("test provider failure session scope"),
            request_id: "req-truncated-200-last".into(),
            payload: json!({
                "model":"client-responses",
                "input":"truncated provider body",
                "stream":false
            }),
        },
        &transport,
        &provider_health,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .expect("a last-candidate transport failure still projects a typed terminal");

    assert_eq!(output.status, 502);
    let observability = output
        .observability
        .as_ref()
        .expect("console observability");
    assert_eq!(observability.provider_failure_events.len(), 1);
    let event = &observability.provider_failure_events[0];
    assert_eq!(event.provider_key, "limited:default:key1:gpt-5.5");
    assert_eq!(event.status, 502);
    assert_eq!(event.health_state, "last_candidate_terminal");
    assert_eq!(event.failure_count, 0);
    assert_eq!(event.cooldown_until_ms, None);

    let now = u64::MAX;
    assert!(
        provider_health
            .store()
            .availability("limited", Some("key1"), Some("gpt-5.5"), now)
            .available,
        "a last-candidate truncated HTTP 200 body must stay health-neutral"
    );
}

/// A completely received upstream HTTP 502 is an ordinary provider error,
/// even when its body is not JSON. It must keep the last-candidate terminal
/// boundary and must not create provider health cooldown.
#[tokio::test]
async fn complete_http_502_is_health_neutral_when_it_is_the_last_candidate() {
    let server_id = "complete_http_502_last_candidate";
    let manifest = single_candidate_manifest(server_id);
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest);
    let output = execute_v3_responses_relay_runtime_with_health_and_retry_policy(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "complete-http-502-last-candidate-session",
            )
            .expect("test provider failure session scope"),
            request_id: "req-complete-http-502-last".into(),
            payload: json!({
                "model":"client-responses",
                "input":"complete upstream HTTP error",
                "stream":false
            }),
        },
        &CompleteHttp502Transport,
        &provider_health,
        V3ResponsesRelayRetryPolicy {
            same_candidate_retries: 0,
        },
    )
    .await
    .expect("a last-candidate HTTP error must project a typed terminal");

    assert_eq!(output.status, 502);
    let observability = output
        .observability
        .as_ref()
        .expect("console observability");
    assert_eq!(observability.provider_failure_events.len(), 1);
    let event = &observability.provider_failure_events[0];
    assert_eq!(event.provider_key, "limited:default:key1:gpt-5.5");
    assert_eq!(event.external_error_status, Some(502));
    assert_eq!(event.health_state, "last_candidate_terminal");
    assert_eq!(event.failure_count, 0);
    assert_eq!(event.cooldown_until_ms, None);

    assert!(
        provider_health
            .store()
            .availability("limited", Some("key1"), Some("gpt-5.5"), u64::MAX)
            .available,
        "a complete upstream HTTP 502 must not cool the last candidate"
    );
}
