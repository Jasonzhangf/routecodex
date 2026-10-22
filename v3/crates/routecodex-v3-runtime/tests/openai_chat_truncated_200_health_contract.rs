//! db1f482 regression on the OpenAI Chat relay boundary: a truncated provider
//! HTTP 200 SSE body is a typed provider transport failure. Its health effect
//! must bind the exact `provider.interfaces.auth.key.model` identity only; it
//! must not cool untried keys, other models, or other providers, and must hold
//! even when the failed identity is the request's last eligible candidate.

use async_trait::async_trait;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderAvailabilityReader, V3ProviderError, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_openai_chat_relay_runtime_with_provider_health, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput, V3ResponsesRelayProviderHealthHandle,
};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

const TRUNCATED_PARTIAL: &[u8] = b"data: {\"id\":\"chatcmpl_truncated\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"chat-wire-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
const HEALTHY_TERMINAL: &[u8] = b"data: {\"id\":\"chatcmpl_healthy\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"chat-wire-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"healthy\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

fn manifest(
    scope: &str,
    with_secondary: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let secondary = if with_secondary {
        format!(
            r#"
[providers.{scope}_secondary]
type = "openai_chat"
base_url = "http://{scope}-secondary.invalid/v1"
default_model = "chat-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "CONTROLLED_SECONDARY_KEY" }}] }}
[providers.{scope}_secondary.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
"#
        )
    } else {
        String::new()
    };
    let secondary_target = if with_secondary {
        format!(
            r#", {{ kind = "provider_model", provider = "{scope}_secondary", model = "chat-wire-model", key = "key1", priority = 1 }}"#
        )
    } else {
        String::new()
    };
    let source = format!(
        r#"
version = 3
[servers.{scope}]
bind = "127.0.0.1"
port = 1
routing_group = "{scope}"
endpoints = ["openai_chat"]
[servers.{scope}.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.{scope}]
type = "openai_chat"
base_url = "http://{scope}.invalid/v1"
default_model = "chat-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "CONTROLLED_KEY" }}] }}
[providers.{scope}.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
{secondary}
[route_groups.{scope}.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }}
targets = [{{ kind = "provider_model", provider = "{scope}", model = "chat-wire-model", key = "key1", priority = 10 }}{secondary_target}]
[route_groups.{scope}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{scope}", model = "chat-wire-model", key = "key1", priority = 10 }}{secondary_target}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

struct TruncatedSseTransport {
    turn: AtomicUsize,
}

#[async_trait]
impl ResponsesTransport for TruncatedSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let _ = self.turn.fetch_add(1, Ordering::SeqCst);
        // HTTP 200 head, one partial business delta, then the body ends before
        // any protocol terminal: a typed provider transport truncation.
        let stream = futures_util::stream::iter([Ok::<Vec<u8>, V3ProviderError>(
            TRUNCATED_PARTIAL.to_vec(),
        )]);
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream),
        ))
    }
}

struct TruncatedThenHealthyTransport {
    truncated_provider: String,
    turn: AtomicUsize,
}

#[async_trait]
impl ResponsesTransport for TruncatedThenHealthyTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let _ = self.turn.fetch_add(1, Ordering::SeqCst);
        let truncated = request.provider_id() == self.truncated_provider;
        let body = if truncated {
            TRUNCATED_PARTIAL
        } else {
            HEALTHY_TERMINAL
        };
        let stream = futures_util::stream::iter([Ok::<Vec<u8>, V3ProviderError>(body.to_vec())]);
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream),
        ))
    }
}

async fn run<T: ResponsesTransport + Sync>(
    scope: &str,
    with_secondary: bool,
    transport: &T,
) -> (
    routecodex_v3_runtime::V3OpenAiChatRelayRuntimeOutput,
    V3ResponsesRelayProviderHealthHandle,
) {
    let manifest = manifest(scope, with_secondary);
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest);
    let output = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        V3OpenAiChatRelayRuntimeInput {
            server_id: scope.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                scope,
            )
            .expect("test provider failure session scope"),
            request_id: format!("req-{scope}"),
            payload: json!({
                "model":"chat-client-alias",
                "messages":[{"role":"user","content":"truncated stream"}],
                "stream":true
            }),
        },
        transport,
        provider_health.runtime_health(),
    )
    .await
    .unwrap_or_else(|error| {
        panic!("truncated provider attempt must stay request-local: {error:?}")
    });
    (output, provider_health)
}

async fn drain(output: &mut routecodex_v3_runtime::V3OpenAiChatRelayRuntimeOutput) -> String {
    match &mut output.client_body {
        V3OpenAiChatRelayClientBody::Sse(stream) => stream
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(String::from_utf8)
            .collect::<Result<String, _>>()
            .expect("client SSE frames must be valid UTF-8"),
        V3OpenAiChatRelayClientBody::Json(value) => value.to_string(),
    }
}

#[tokio::test]
async fn openai_chat_truncated_200_keeps_last_candidate_health_neutral() {
    let scope = "openai_chat_truncated_last";
    let transport = TruncatedSseTransport {
        turn: AtomicUsize::new(0),
    };
    let (mut output, provider_health) = run(scope, false, &transport).await;
    let body = drain(&mut output).await;
    let attempts = output.provider_failure_attempts.clone();

    let now = u64::MAX;
    let exact =
        provider_health
            .store()
            .availability(scope, Some("key1"), Some("chat-wire-model"), now);
    assert!(
        exact.available,
        "a truncated HTTP 200 SSE body must stay health-neutral without an alternative: attempts={attempts:?} body={body}"
    );
    assert!(
        provider_health
            .store()
            .availability(scope, Some("key1"), Some("other-model"), now)
            .available,
        "another model under the same provider and key must stay routable"
    );
    assert!(
        provider_health
            .store()
            .availability(scope, Some("other-key"), Some("chat-wire-model"), now)
            .available,
        "another key under the same provider and model must stay routable"
    );
}

#[tokio::test]
async fn openai_chat_truncated_200_switches_without_cooling_other_identities() {
    let scope = "openai_chat_truncated_switch";
    let transport = TruncatedThenHealthyTransport {
        truncated_provider: scope.to_string(),
        turn: AtomicUsize::new(0),
    };
    let (mut output, provider_health) = run(scope, true, &transport).await;
    let body = drain(&mut output).await;

    assert_eq!(output.status, 200, "healthy secondary must project: {body}");
    assert!(
        output.node_trace.contains(&"V3TargetLocalReselected"),
        "truncated primary must reselect: {:?}",
        output.node_trace
    );

    let now = u64::MAX;
    assert!(
        !provider_health
            .store()
            .availability(scope, Some("key1"), Some("chat-wire-model"), now)
            .available,
        "the exact failed identity must be cooled"
    );
    assert!(
        provider_health
            .store()
            .availability(scope, Some("key1"), Some("other-model"), now)
            .available,
        "another model under the same provider and key must stay routable"
    );
    assert!(
        provider_health
            .store()
            .availability(scope, Some("other-key"), Some("chat-wire-model"), now)
            .available,
        "another key under the same provider and model must stay routable"
    );
    assert!(
        provider_health
            .store()
            .availability(
                &format!("{scope}_secondary"),
                Some("key1"),
                Some("chat-wire-model"),
                now
            )
            .available,
        "the untried secondary provider must stay routable"
    );
}
