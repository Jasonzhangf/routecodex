//! Library-side regression for the shared Relay core construction-failure edge.
//!
//! The core owns one `handle_provider_failure` call chain. A protocol codec
//! construction failure that is already a typed `V3RelayCoreError::Provider`
//! must reach the existing shared `provider_runtime_failure` +
//! `handle_provider_failure` owner. The old edge flattened every construction
//! error to a Display string through `request_failure_builder`, so the real
//! `V3ProviderError` variant never reached the failure/recovery owner.
//!
//! These tests drive the real public OpenAI Chat relay runtime entry (the
//! actual consumer of `execute_v3_relay_runtime_core`), not the codec or the
//! outer mapper in isolation.
//!
//! The public output must retain the provider-local classification, source
//! code, original cause and request-lane status. A generic Display failure
//! cannot satisfy those typed source assertions.

use super::*;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderResp14Raw, V3Transport13ResponsesHttpRequest,
};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

/// Records whether the provider transport was reached. A construction failure
/// must abort before any provider wire attempt, so this must stay false.
struct ConstructionFailureTransport {
    send_called: AtomicBool,
}

impl ConstructionFailureTransport {
    fn new() -> Self {
        Self {
            send_called: AtomicBool::new(false),
        }
    }
}

#[async_trait::async_trait]
impl ResponsesTransport for ConstructionFailureTransport {
    async fn send(
        &self,
        _request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.send_called.store(true, Ordering::SeqCst);
        Err(V3ProviderError::Transport {
            request_id: "req-core-typed-construction".to_string(),
            provider_id: "core-typed-provider".to_string(),
            reason: "construction failure must abort before provider transport".to_string(),
        })
    }
}

fn ensure_core_transport_test_state_dir() {
    static INITIALIZE: std::sync::Once = std::sync::Once::new();
    INITIALIZE.call_once(|| {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock must follow the Unix epoch")
            .as_nanos();
        let state_dir = std::env::temp_dir().join(format!(
            "routecodex-v3-relay-core-transport-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&state_dir)
            .expect("core transport test must own an isolated provider state directory");
        std::env::set_var("ROUTECODEX_V3_STATE_DIR", &state_dir);
        std::env::set_var(
            "ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE",
            state_dir.join("provider-cooldowns.json"),
        );
    });
}

/// Manifest for the actual public OpenAI Chat Relay entry. The provider base
/// URL is intentionally unparsable so the codec `build_transport_request`
/// returns a typed `V3RelayCoreError::Provider(V3ProviderError::InvalidBaseUrl)`.
fn core_transport_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    ensure_core_transport_test_state_dir();
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.core_transport]
bind = "127.0.0.1"
port = 1
routing_group = "core_transport"
endpoints = ["openai_chat"]
[servers.core_transport.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}
[providers.core_transport]
type = "openai_chat"
base_url = "not-a-valid-base-url"
default_model = "core-wire-model"
auth = { type = "api_key", entries = [{ alias = "core", env = "V3_CORE_TRANSPORT_KEY" }] }
[providers.core_transport.models.core-wire-model]
wire_name = "core-wire-model"
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.core_transport.pools.chat_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "openai_chat", models = ["core-client-alias"] }
targets = [{ kind = "provider_model", provider = "core_transport", model = "core-wire-model", key = "core", priority = 1 }]
[route_groups.core_transport.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "core_transport", model = "core-wire-model", key = "core", priority = 1 }]
"#,
        )
        .expect("core transport authoring must parse"),
    )
    .expect("core transport manifest must compile")
}

/// The real OpenAI Chat Relay entry must hand the typed Provider construction
/// failure to the shared `provider_runtime_failure` owner. We prove the typed
/// path by checking the typed classification and source code exposed by the
/// failure owner. The original cause remains diagnostic evidence.
#[tokio::test]
async fn relay_core_typed_provider_construction_failure_reaches_shared_failure_owner() {
    let manifest = core_transport_manifest();
    let transport = ConstructionFailureTransport::new();
    let provider_health =
        V3ResponsesRelayProviderHealthHandle::from_manifest_without_persistence(&manifest);
    let input = V3OpenAiChatRelayRuntimeInput {
        server_id: "core_transport".to_string(),
        failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
            "core-transport-server",
            "core_transport",
            "relay_core_typed_provider_construction_failure",
        )
        .expect("typed provider failure session scope"),
        request_id: "req-core-typed-construction".to_string(),
        payload: json!({
            "model": "core-client-alias",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }),
    };

    let output = execute_v3_openai_chat_relay_runtime_with_provider_health(
        &manifest,
        input,
        &transport,
        provider_health.runtime_health(),
    )
    .await
    .expect(
        "a construction failure must be projected by the failure owner, not returned as an error",
    );

    assert!(
        !transport.send_called.load(Ordering::SeqCst),
        "an invalid base URL must abort before any provider transport attempt"
    );

    let body = match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(body) => body.clone(),
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("construction failure must project JSON"),
    };
    assert_eq!(
        output.error_class,
        Some("provider_local_failure"),
        "the shared failure owner must consume the original typed provider-local source"
    );
    assert_eq!(
        body["error"]["code"], "provider_local_runtime_error",
        "the source code must survive the shared Relay core boundary"
    );
    assert_eq!(
        output.error_detail.as_deref(),
        body["error"]["message"].as_str(),
        "the original cause must be retained as diagnostic detail"
    );
    assert!(
        output.error_detail.as_deref().is_some_and(|detail| {
            detail.contains("core_transport") && detail.contains("invalid Responses base URL")
        }),
        "the original construction cause must not become a generic Display failure code"
    );
    assert_eq!(
        output.status, 598,
        "the diagnostic projection must retain the internal request lane"
    );
    assert_eq!(
        output.error_chain.as_deref(),
        Some(routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS.as_slice()),
        "the construction failure must be projected through the typed Error chain"
    );
}
