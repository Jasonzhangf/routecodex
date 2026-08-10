use crate::adaptive_concurrency::{
    V3AdaptiveConcurrencyController, V3AdaptiveConcurrencyPermit, V3AdaptiveConcurrencyPermitGuard,
    V3AdaptiveConcurrencyProbeResult,
};
use crate::raw_response::{V3ProviderResp14Raw, V3ProviderResponseBody, V3ProviderSseStream};
use crate::shared::{collect_response_headers, content_type, validated_sse_stream};
use crate::wire::{
    V3Provider12ResponsesWirePayload, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ResponsesStreamIntent,
};
use crate::{V3ProviderError, V3ProviderHttpFailure, V3ProviderResponseHeader};
use async_trait::async_trait;
use futures_util::{stream, SinkExt, StreamExt};
use routecodex_v3_config::V3ResponsesTransportKind;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderValue},
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};

type ResponsesWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type SharedResponsesWebSocket = Arc<Mutex<Option<ResponsesWebSocket>>>;

mod cancellation;
mod websocket;
pub use cancellation::V3ProviderCancellation;
use websocket::{websocket_protocol_error, websocket_server_event_error, websocket_transport_error};

const OPENAI_BETA_HEADER: &str = "openai-beta";
const RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE: &str = "responses_websockets=2026-02-06";
const CLAUDE_CODE_USER_AGENT: &str = "claude-cli/2.1.220 (external, sdk-cli)";
const CLAUDE_CODE_ANTHROPIC_BETA: &str = "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01";
const ANTHROPIC_PROVIDER_HEADER_NAMES: &[&str] = &[
    "user-agent",
    "anthropic-version",
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "x-app",
    "x-stainless-lang",
    "x-stainless-package-version",
    "x-stainless-runtime",
    "x-stainless-retry-count",
    "x-stainless-timeout",
];
const V3_PROVIDER_HTTP_READ_TIMEOUT_SECS: u64 = 300;
const V3_RESPONSES_WEBSOCKET_PROTOCOL_AGGREGATION_OWNER: &str =
    "V3ProviderResponsesWebSocketSession -> V3ProviderResp14Raw";

#[derive(Debug)]
enum V3Transport13ResponsesRequestKind {
    Http {
        request_id: String,
        provider_id: String,
        url: reqwest::Url,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        body: Value,
        provider_headers: Vec<V3ProviderRequestHeader>,
        timeout: Option<Duration>,
        initial_concurrency_budget: u32,
        cancellation: Option<V3ProviderCancellation>,
    },
    WebSocketV2 {
        request_id: String,
        provider_id: String,
        canonical_model_id: String,
        url: String,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        event: Value,
        initial_concurrency_budget: u32,
        cancellation: Option<V3ProviderCancellation>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderRequestHeader {
    name: String,
    value: String,
}

impl V3ProviderRequestHeader {
    pub fn new(name: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            name: normalize_provider_header_name(name.into()),
            value: value.into(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn value(&self) -> &str {
        &self.value
    }
}

pub fn build_v3_anthropic_provider_request_header(
    name: impl Into<String>,
    value: impl Into<String>,
) -> Option<V3ProviderRequestHeader> {
    let name = normalize_provider_header_name(name.into());
    is_v3_anthropic_provider_request_header_name(&name).then(|| V3ProviderRequestHeader {
        name,
        value: value.into(),
    })
}

pub fn is_v3_anthropic_provider_request_header_name(name: impl AsRef<str>) -> bool {
    let name = normalize_provider_header_name(name.as_ref().to_string());
    ANTHROPIC_PROVIDER_HEADER_NAMES
        .iter()
        .any(|allowed| *allowed == name)
}

fn normalize_provider_header_name(name: String) -> String {
    name.trim().to_ascii_lowercase()
}

#[derive(Debug)]
pub struct V3Transport13ResponsesRequest {
    _sealed: (),
    kind: V3Transport13ResponsesRequestKind,
}

pub type V3Transport13ResponsesHttpRequest = V3Transport13ResponsesRequest;

impl V3Transport13ResponsesRequest {
    fn provider_key(&self) -> String {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { auth, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { auth, .. } => {
                format!("{}:{}", self.provider_id(), auth.alias)
            }
        }
    }

    fn cancellation(&self) -> Option<V3ProviderCancellation> {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { cancellation, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { cancellation, .. } => {
                cancellation.clone()
            }
        }
    }
}

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(u64::MAX as u128) as u64
        })
}

fn is_rate_limited(error: &V3ProviderError) -> bool {
    matches!(
        error,
        V3ProviderError::HttpStatus { response } if response.status == 429
    )
}

impl V3Transport13ResponsesRequest {
    pub fn request_id(&self) -> &str {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { request_id, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { request_id, .. } => request_id,
        }
    }

    pub fn provider_id(&self) -> &str {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { provider_id, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { provider_id, .. } => provider_id,
        }
    }

    fn initial_concurrency_budget(&self) -> u32 {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http {
                initial_concurrency_budget,
                ..
            }
            | V3Transport13ResponsesRequestKind::WebSocketV2 {
                initial_concurrency_budget,
                ..
            } => *initial_concurrency_budget,
        }
    }

    pub fn url(&self) -> &str {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { url, .. } => url.as_str(),
            V3Transport13ResponsesRequestKind::WebSocketV2 { url, .. } => url,
        }
    }

    pub fn body(&self) -> &Value {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { body, .. } => body,
            V3Transport13ResponsesRequestKind::WebSocketV2 { event, .. } => event,
        }
    }

    pub fn stream_intent(&self) -> V3ResponsesStreamIntent {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { stream_intent, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { stream_intent, .. } => {
                *stream_intent
            }
        }
    }

    pub fn provider_headers(&self) -> &[V3ProviderRequestHeader] {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http {
                provider_headers, ..
            } => provider_headers,
            V3Transport13ResponsesRequestKind::WebSocketV2 { .. } => &[],
        }
    }

    pub fn redacted_provider_request_projection(&self) -> Value {
        let stream_intent = match self.stream_intent() {
            V3ResponsesStreamIntent::Json => "json",
            V3ResponsesStreamIntent::Sse => "sse",
        };
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { .. } => json!({
                "method": "POST",
                "providerId": self.provider_id(),
                "url": self.url(),
                "headers": redacted_http_request_headers(self.url(), self.stream_intent(), self.provider_headers()),
                "body": self.body(),
                "streamIntent": stream_intent
            }),
            V3Transport13ResponsesRequestKind::WebSocketV2 { .. } => json!({
                "method": "WEBSOCKET",
                "providerId": self.provider_id(),
                "url": self.url(),
                "headers": {
                    "authorization": "[REDACTED]",
                    "openai-beta": RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE
                },
                "body": self.body(),
                "streamIntent": stream_intent
            }),
        }
    }

    pub fn with_cancellation(mut self, value: V3ProviderCancellation) -> Self {
        match &mut self.kind {
            V3Transport13ResponsesRequestKind::Http { cancellation, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { cancellation, .. } => {
                *cancellation = Some(value);
            }
        }
        self
    }
}

fn redacted_http_request_headers(
    url: &str,
    stream_intent: V3ResponsesStreamIntent,
    provider_headers: &[V3ProviderRequestHeader],
) -> Value {
    let mut headers = serde_json::Map::new();
    headers.insert(
        "accept".to_string(),
        Value::String(
            if stream_intent == V3ResponsesStreamIntent::Sse {
                "text/event-stream"
            } else {
                "application/json"
            }
            .to_string(),
        ),
    );
    headers.insert(
        "authorization".to_string(),
        Value::String("[REDACTED]".to_string()),
    );
    headers.insert(
        "content-type".to_string(),
        Value::String("application/json".to_string()),
    );
    if is_anthropic_messages_url_text(url) {
        headers.insert(
            "x-api-key".to_string(),
            Value::String("[REDACTED]".to_string()),
        );
        for header in default_anthropic_messages_compat_headers() {
            headers.insert(header.name, Value::String(header.value));
        }
        for header in provider_headers {
            headers.insert(
                header.name().to_string(),
                Value::String(redacted_provider_header_value(
                    header.name(),
                    header.value(),
                )),
            );
        }
    }
    Value::Object(headers)
}

fn is_anthropic_messages_url_text(url: &str) -> bool {
    reqwest::Url::parse(url)
        .map(|url| is_anthropic_messages_url(&url))
        .unwrap_or_else(|_| url.trim_end_matches('/').ends_with("/v1/messages"))
}

fn is_anthropic_messages_url(url: &reqwest::Url) -> bool {
    url.path().trim_end_matches('/').ends_with("/v1/messages")
}

fn apply_anthropic_messages_compat_headers(
    mut builder: reqwest::RequestBuilder,
    secret: &str,
    provider_headers: &[V3ProviderRequestHeader],
) -> reqwest::RequestBuilder {
    builder = builder.header("x-api-key", secret);
    for header in default_anthropic_messages_compat_headers() {
        builder = builder.header(header.name, header.value);
    }
    for header in provider_headers {
        builder = builder.header(header.name(), header.value());
    }
    builder
}

fn default_anthropic_messages_compat_headers() -> Vec<V3ProviderRequestHeader> {
    vec![
        V3ProviderRequestHeader::new("anthropic-version", "2023-06-01"),
        V3ProviderRequestHeader::new("anthropic-beta", CLAUDE_CODE_ANTHROPIC_BETA),
        V3ProviderRequestHeader::new("anthropic-dangerous-direct-browser-access", "true"),
        V3ProviderRequestHeader::new("x-app", "cli"),
        V3ProviderRequestHeader::new("user-agent", CLAUDE_CODE_USER_AGENT),
        V3ProviderRequestHeader::new("x-stainless-lang", "js"),
        V3ProviderRequestHeader::new("x-stainless-package-version", "0.94.0"),
        V3ProviderRequestHeader::new("x-stainless-runtime", "node"),
        V3ProviderRequestHeader::new("x-stainless-retry-count", "0"),
        V3ProviderRequestHeader::new("x-stainless-timeout", "300"),
    ]
}

fn redacted_provider_header_value(_name: &str, value: &str) -> String {
    value.to_string()
}

fn v3_transport_13_request(
    kind: V3Transport13ResponsesRequestKind,
) -> V3Transport13ResponsesRequest {
    V3Transport13ResponsesRequest { _sealed: (), kind }
}

pub fn build_v3_transport_13_responses_request_from_v3_provider_12(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesRequest, V3ProviderError> {
    let (request_id, target, stream_intent, body) = wire.into_parts();
    let provider_id = target.provider_id;
    let request_timeout_ms = target.request_timeout_ms;
    let initial_concurrency_budget = target.initial_concurrency_budget;
    match target.responses_transport {
        V3ResponsesTransportKind::Http => {
            let mut body = body;
            let mut url_text = format!("{}/responses", target.base_url.trim_end_matches('/'));
            if let Some(response_id) = extract_http_submit_tool_outputs_response_id(&mut body) {
                url_text = build_http_submit_tool_outputs_url(
                    &request_id,
                    &provider_id,
                    &url_text,
                    &response_id,
                )?;
            }
            let mut request = build_v3_transport_13_responses_http_request_from_parts_with_timeout(
                request_id,
                provider_id,
                url_text,
                target.auth,
                stream_intent,
                body,
                Vec::new(),
                Some(Duration::from_millis(request_timeout_ms)),
            )?;
            if let V3Transport13ResponsesRequestKind::Http {
                initial_concurrency_budget: budget,
                ..
            } = &mut request.kind
            {
                *budget = initial_concurrency_budget;
            }
            Ok(request)
        }
        V3ResponsesTransportKind::WebsocketV2 => {
            let url =
                target
                    .websocket_v2_url
                    .ok_or_else(|| V3ProviderError::WebSocketTransport {
                        request_id: request_id.clone(),
                        provider_id: provider_id.clone(),
                        reason: "websocket_v2 target has no endpoint".to_string(),
                    })?;
            let mut body = body;
            let event = body
                .as_object_mut()
                .ok_or_else(|| V3ProviderError::InvalidWireBody {
                    request_id: request_id.clone(),
                })?;
            event.remove("stream");
            event.remove("background");
            event.insert(
                "type".to_string(),
                Value::String("response.create".to_string()),
            );
            Ok(v3_transport_13_request(
                V3Transport13ResponsesRequestKind::WebSocketV2 {
                    request_id,
                    provider_id,
                    canonical_model_id: target.canonical_model_id,
                    url,
                    auth: target.auth,
                    stream_intent,
                    event: body,
                    initial_concurrency_budget,
                    cancellation: None,
                },
            ))
        }
    }
}

fn extract_http_submit_tool_outputs_response_id(body: &mut Value) -> Option<String> {
    let object = body.as_object_mut()?;
    let raw_id = object
        .get("response_id")
        .and_then(Value::as_str)
        .or_else(|| object.get("responseId").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    let has_tool_outputs = object
        .get("tool_outputs")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    if !has_tool_outputs {
        return None;
    }
    let response_id = raw_id.to_string();
    object.remove("response_id");
    object.remove("responseId");
    Some(response_id)
}

fn build_http_submit_tool_outputs_url(
    request_id: &str,
    provider_id: &str,
    responses_url: &str,
    response_id: &str,
) -> Result<String, V3ProviderError> {
    let mut url =
        reqwest::Url::parse(responses_url).map_err(|error| V3ProviderError::InvalidBaseUrl {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: error.to_string(),
        })?;
    url.path_segments_mut()
        .map_err(|()| V3ProviderError::InvalidBaseUrl {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: "responses URL cannot be a base for submit_tool_outputs".to_string(),
        })?
        .push(response_id)
        .push("submit_tool_outputs");
    Ok(url.to_string())
}

pub fn build_v3_transport_13_responses_http_request_from_parts(
    request_id: impl Into<String>,
    provider_id: impl Into<String>,
    url_text: impl AsRef<str>,
    auth: V3ProviderAuthHandle,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        request_id,
        provider_id,
        url_text,
        auth,
        stream_intent,
        body,
        Vec::new(),
        None,
    )
}

pub fn build_v3_transport_13_responses_http_request_with_provider_headers_from_parts(
    request_id: impl Into<String>,
    provider_id: impl Into<String>,
    url_text: impl AsRef<str>,
    auth: V3ProviderAuthHandle,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
    provider_headers: Vec<V3ProviderRequestHeader>,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    build_v3_transport_13_responses_http_request_from_parts_with_timeout(
        request_id,
        provider_id,
        url_text,
        auth,
        stream_intent,
        body,
        provider_headers,
        None,
    )
}

/// 带 per-request 总超时（覆盖连接、响应头等待与 body 读取；None = 不设置，
/// 仅由 client 级 `read_timeout` 兜底）的 transport request 构建。
pub fn build_v3_transport_13_responses_http_request_from_parts_with_timeout(
    request_id: impl Into<String>,
    provider_id: impl Into<String>,
    url_text: impl AsRef<str>,
    auth: V3ProviderAuthHandle,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
    provider_headers: Vec<V3ProviderRequestHeader>,
    timeout: Option<Duration>,
) -> Result<V3Transport13ResponsesHttpRequest, V3ProviderError> {
    let request_id = request_id.into();
    let provider_id = provider_id.into();
    let url = reqwest::Url::parse(url_text.as_ref()).map_err(|error| {
        V3ProviderError::InvalidBaseUrl {
            request_id: request_id.clone(),
            provider_id: provider_id.clone(),
            reason: error.to_string(),
        }
    })?;
    Ok(v3_transport_13_request(
        V3Transport13ResponsesRequestKind::Http {
            request_id,
            provider_id,
            url,
            auth,
            stream_intent,
            body,
            provider_headers,
            timeout,
            initial_concurrency_budget: 8,
            cancellation: None,
        },
    ))
}

pub fn build_v3_transport_13_responses_http_request_from_v3_provider_12(
    wire: V3Provider12ResponsesWirePayload,
) -> Result<V3Transport13ResponsesRequest, V3ProviderError> {
    build_v3_transport_13_responses_request_from_v3_provider_12(wire)
}

#[async_trait]
pub trait ResponsesTransport: Send + Sync {
    async fn send(
        &self,
        request: V3Transport13ResponsesRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError>;
}

#[derive(Clone)]
pub struct ProviderResponsesTransport {
    client: reqwest::Client,
    websocket_sessions: Arc<Mutex<BTreeMap<String, SharedResponsesWebSocket>>>,
}

impl fmt::Debug for ProviderResponsesTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderResponsesTransport")
            .finish_non_exhaustive()
    }
}

impl Default for ProviderResponsesTransport {
    fn default() -> Self {
        Self::with_http_read_timeout(Duration::from_secs(V3_PROVIDER_HTTP_READ_TIMEOUT_SECS))
    }
}

impl ProviderResponsesTransport {
    fn with_http_read_timeout(timeout: Duration) -> Self {
        Self {
            client: reqwest::Client::builder()
                .read_timeout(timeout)
                .build()
                .expect("valid V3 provider HTTP client read timeout"),
            websocket_sessions: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    #[cfg(test)]
    fn with_http_read_timeout_for_test(timeout: Duration) -> Self {
        Self::with_http_read_timeout(timeout)
    }
}

pub type ReqwestResponsesTransport = ProviderResponsesTransport;

#[async_trait]
impl ResponsesTransport for ProviderResponsesTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let provider_key = request.provider_key();
        let cancellation = request.cancellation();
        let request_id = request.request_id().to_string();
        let provider_id = request.provider_id().to_string();
        let controller = V3AdaptiveConcurrencyController::process_shared();
        controller
            .ensure_initial_budget(&provider_key, request.initial_concurrency_budget())
            .map_err(|reason| V3ProviderError::Transport {
                request_id: request_id.clone(),
                provider_id: provider_id.clone(),
                reason,
            })?;
        let lease = if let Some(cancellation) = cancellation.clone() {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    return Err(V3ProviderError::ClientDisconnect {
                        request_id: request.request_id().to_string(),
                        provider_id: request.provider_id().to_string(),
                    });
                }
                lease = controller.acquire_with_clock(provider_key.clone(), current_epoch_ms) => lease,
            }
        } else {
            controller
                .acquire_with_clock(provider_key.clone(), current_epoch_ms)
                .await
        };
        let was_probe = lease.is_probe();
        let permit = lease.into_permit();
        let result = match request.kind {
            V3Transport13ResponsesRequestKind::Http {
                request_id,
                provider_id,
                url,
                auth,
                stream_intent,
                body,
                provider_headers,
                timeout,
                initial_concurrency_budget: _,
                cancellation,
            } => {
                self.send_http(
                    request_id,
                    provider_id,
                    url,
                    auth,
                    stream_intent,
                    body,
                    provider_headers,
                    timeout,
                    cancellation,
                )
                .await
            }
            V3Transport13ResponsesRequestKind::WebSocketV2 {
                request_id,
                provider_id,
                canonical_model_id,
                url,
                auth,
                stream_intent,
                event,
                initial_concurrency_budget: _,
                cancellation,
            } => {
                self.send_websocket_v2(
                    request_id,
                    provider_id,
                    canonical_model_id,
                    url,
                    auth,
                    stream_intent,
                    event,
                    cancellation,
                )
                .await
            }
        };
        let now_ms = current_epoch_ms();
        match result {
            Ok(raw) => {
                if was_probe {
                    controller
                        .complete_probe(permit, V3AdaptiveConcurrencyProbeResult::Accepted, now_ms)
                        .map_err(|reason| V3ProviderError::Transport {
                            request_id: raw.request_id().to_string(),
                            provider_id: raw.provider_id().to_string(),
                            reason,
                        })?;
                } else if raw.body_kind() == crate::raw_response::V3ProviderResponseBodyKind::Sse {
                    return Ok(hold_sse_lease(raw, controller.clone(), permit));
                } else {
                    controller
                        .release(permit)
                        .map_err(|reason| V3ProviderError::Transport {
                            request_id: raw.request_id().to_string(),
                            provider_id: raw.provider_id().to_string(),
                            reason,
                        })?;
                }
                Ok(raw)
            }
            Err(error) => {
                if is_rate_limited(&error) {
                    if was_probe {
                        controller
                            .complete_probe(
                                permit,
                                V3AdaptiveConcurrencyProbeResult::RateLimited,
                                now_ms,
                            )
                            .map_err(|reason| V3ProviderError::Transport {
                                request_id: request_id.clone(),
                                provider_id: provider_id.clone(),
                                reason,
                            })?;
                    } else {
                        controller
                            .observe_rate_limit(&provider_key, now_ms)
                            .map_err(|reason| V3ProviderError::Transport {
                                request_id: request_id.clone(),
                                provider_id: provider_id.clone(),
                                reason,
                            })?;
                        controller.release(permit).map_err(|reason| {
                            V3ProviderError::Transport {
                                request_id: request_id.clone(),
                                provider_id: provider_id.clone(),
                                reason,
                            }
                        })?;
                    }
                } else {
                    controller
                        .release(permit)
                        .map_err(|reason| V3ProviderError::Transport {
                            request_id: request_id.clone(),
                            provider_id: provider_id.clone(),
                            reason,
                        })?;
                }
                Err(error)
            }
        }
    }
}

fn hold_sse_lease(
    raw: V3ProviderResp14Raw,
    controller: V3AdaptiveConcurrencyController,
    permit: V3AdaptiveConcurrencyPermit,
) -> V3ProviderResp14Raw {
    let (request_id, provider_id, status, headers, body) = raw.into_parts();
    let V3ProviderResponseBody::Sse(stream) = body else {
        unreachable!("SSE lease must only wrap an SSE response");
    };
    let guard = V3AdaptiveConcurrencyPermitGuard::new(controller, permit);
    let stream = Box::pin(stream::unfold(
        (stream, guard),
        |(mut stream, guard)| async move { stream.next().await.map(|item| (item, (stream, guard))) },
    ));
    V3ProviderResp14Raw::from_sse(request_id, provider_id, status, headers, stream)
}

impl ProviderResponsesTransport {
    #[allow(clippy::too_many_arguments)]
    async fn send_http(
        &self,
        request_id: String,
        provider_id: String,
        url: reqwest::Url,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        body: Value,
        provider_headers: Vec<V3ProviderRequestHeader>,
        timeout: Option<Duration>,
        cancellation: Option<V3ProviderCancellation>,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        ensure_not_cancelled(&request_id, &provider_id, cancellation.as_ref())?;
        let secret = resolve_secret(&request_id, &provider_id, &auth).await?;
        let accept = match stream_intent {
            V3ResponsesStreamIntent::Json => "application/json",
            V3ResponsesStreamIntent::Sse => "text/event-stream",
        };
        let anthropic_messages = is_anthropic_messages_url(&url);
        let provider_headers = provider_headers.clone();
        let mut request = self
            .client
            .post(url)
            .header(reqwest::header::ACCEPT, accept)
            .bearer_auth(&secret);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if anthropic_messages {
            request = apply_anthropic_messages_compat_headers(request, &secret, &provider_headers);
        }
        let send = request.json(&body).send();
        let response = match cancellation.clone() {
            Some(cancellation) => {
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        return Err(V3ProviderError::ClientDisconnect { request_id, provider_id });
                    }
                    response = send => response,
                }
            }
            None => send.await,
        }
        .map_err(|error| V3ProviderError::Transport {
            request_id: request_id.clone(),
            provider_id: provider_id.clone(),
            reason: error.to_string(),
        })?;

        let status = response.status().as_u16();
        let headers = collect_response_headers(response.headers());
        let response_content_type = content_type(response.headers());
        if status >= 400 {
            let body = match read_response_body_bytes(
                response,
                &request_id,
                &provider_id,
                cancellation.clone(),
            )
            .await
            {
                Ok(body) => body,
                Err(V3ProviderError::ClientDisconnect {
                    request_id: client_request_id,
                    provider_id: client_provider_id,
                }) => {
                    return Err(V3ProviderError::ClientDisconnect {
                        request_id: client_request_id,
                        provider_id: client_provider_id,
                    });
                }
                Err(V3ProviderError::ResponseBody { .. }) => Vec::new(),
                Err(other) => return Err(other),
            };
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id,
                    provider_id,
                    status,
                    headers,
                    body,
                }),
            });
        }

        if response_content_type
            .as_deref()
            .is_some_and(|value| value.starts_with("application/json"))
        {
            let body =
                read_response_body_bytes(response, &request_id, &provider_id, cancellation).await?;
            return Ok(V3ProviderResp14Raw::from_json(
                request_id,
                provider_id,
                status,
                headers,
                body,
            ));
        }

        match stream_intent {
            V3ResponsesStreamIntent::Json => Err(V3ProviderError::UnexpectedContentType {
                request_id,
                provider_id,
                expected: "JSON",
                content_type: response_content_type,
            }),
            V3ResponsesStreamIntent::Sse
                if response_content_type
                    .as_deref()
                    .is_some_and(|value| value.starts_with("text/event-stream")) =>
            {
                let stream = validated_sse_stream(
                    response.bytes_stream(),
                    request_id.clone(),
                    provider_id.clone(),
                    cancellation,
                );
                Ok(V3ProviderResp14Raw::from_sse(
                    request_id,
                    provider_id,
                    status,
                    headers,
                    stream,
                ))
            }
            V3ResponsesStreamIntent::Sse => Err(V3ProviderError::UnexpectedContentType {
                request_id,
                provider_id,
                expected: "SSE",
                content_type: response_content_type,
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_websocket_v2(
        &self,
        request_id: String,
        provider_id: String,
        canonical_model_id: String,
        url: String,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        event: Value,
        cancellation: Option<V3ProviderCancellation>,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        ensure_not_cancelled(&request_id, &provider_id, cancellation.as_ref())?;
        let secret = resolve_secret(&request_id, &provider_id, &auth).await?;
        let session_key = format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            provider_id, canonical_model_id, auth.alias, url
        );
        let session = {
            let mut sessions = self.websocket_sessions.lock().await;
            sessions
                .entry(session_key)
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut connection = session.lock_owned().await;
        if connection.is_none() {
            let mut handshake = url
                .clone()
                .into_client_request()
                .map_err(|error| websocket_transport_error(&request_id, &provider_id, error))?;
            let authorization = HeaderValue::from_str(&format!("Bearer {secret}"))
                .map_err(|error| websocket_transport_error(&request_id, &provider_id, error))?;
            handshake.headers_mut().insert(AUTHORIZATION, authorization);
            handshake.headers_mut().insert(
                OPENAI_BETA_HEADER,
                HeaderValue::from_static(RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE),
            );
            let connect = connect_async(handshake);
            let connected = match cancellation.clone() {
                Some(cancellation) => {
                    tokio::select! {
                        _ = cancellation.cancelled() => {
                            return Err(V3ProviderError::ClientDisconnect { request_id, provider_id });
                        }
                        connected = connect => connected,
                    }
                }
                None => connect.await,
            }
            .map_err(|error| websocket_transport_error(&request_id, &provider_id, error))?;
            *connection = Some(connected.0);
        }

        let socket = connection
            .as_mut()
            .expect("WebSocket connection initialized");
        let encoded = serde_json::to_string(&event)
            .map_err(|error| websocket_protocol_error(&request_id, &provider_id, error))?;
        let send = socket.send(Message::Text(encoded));
        match cancellation.clone() {
            Some(cancellation) => {
                tokio::select! {
                    _ = cancellation.cancelled() => {
                        let _ = socket.close(None).await;
                        *connection = None;
                        return Err(V3ProviderError::ClientDisconnect { request_id, provider_id });
                    }
                    result = send => result,
                }
            }
            None => send.await,
        }
        .map_err(|error| websocket_transport_error(&request_id, &provider_id, error))?;

        if stream_intent == V3ResponsesStreamIntent::Sse {
            return Ok(V3ProviderResp14Raw::from_sse(
                request_id.clone(),
                provider_id.clone(),
                200,
                vec![content_type_header("text/event-stream")],
                websocket::websocket_sse_stream(connection, request_id, provider_id, cancellation),
            ));
        }

        let mut json_events = websocket::V3ResponsesWebSocketProtocolAggregate::default();
        loop {
            let next = match cancellation.clone() {
                Some(cancellation) => {
                    tokio::select! {
                        _ = cancellation.cancelled() => {
                            let _ = socket.close(None).await;
                            *connection = None;
                            return Err(V3ProviderError::ClientDisconnect { request_id, provider_id });
                        }
                        next = socket.next() => next,
                    }
                }
                None => socket.next().await,
            };
            let Some(message) = next else {
                *connection = None;
                return Err(websocket_protocol_error(
                    &request_id,
                    &provider_id,
                    "connection closed before terminal response event",
                ));
            };
            let message = match message {
                Ok(message) => message,
                Err(error) => {
                    *connection = None;
                    return Err(websocket_transport_error(&request_id, &provider_id, error));
                }
            };
            let bytes = match message {
                Message::Text(text) => text.as_bytes().to_vec(),
                Message::Binary(bytes) => bytes.to_vec(),
                Message::Ping(payload) => {
                    if let Err(error) = socket.send(Message::Pong(payload)).await {
                        *connection = None;
                        return Err(websocket_transport_error(&request_id, &provider_id, error));
                    }
                    continue;
                }
                Message::Pong(_) | Message::Frame(_) => continue,
                Message::Close(_) => {
                    *connection = None;
                    return Err(websocket_protocol_error(
                        &request_id,
                        &provider_id,
                        "connection closed before terminal response event",
                    ));
                }
            };
            let server_event: Value = match serde_json::from_slice(&bytes) {
                Ok(event) => event,
                Err(error) => {
                    *connection = None;
                    return Err(websocket_protocol_error(&request_id, &provider_id, error));
                }
            };
            let event_type = match server_event.get("type").and_then(Value::as_str) {
                Some(event_type) => event_type,
                None => {
                    *connection = None;
                    return Err(websocket_protocol_error(
                        &request_id,
                        &provider_id,
                        "server event is missing type",
                    ));
                }
            };

            if let Some(error) =
                websocket_server_event_error(event_type, &server_event, &request_id, &provider_id)
            {
                *connection = None;
                return Err(error);
            }

            if let Err(error) =
                json_events.record(event_type, &server_event, &request_id, &provider_id)
            {
                *connection = None;
                return Err(error);
            }
            if event_type != "response.completed" {
                continue;
            }

            let response = match server_event.get("response") {
                Some(response) => response,
                None => {
                    *connection = None;
                    return Err(websocket_protocol_error(
                        &request_id,
                        &provider_id,
                        "response.completed is missing response",
                    ));
                }
            };
            let response = json_events
                .apply_responses_websocket_protocol_events_to_terminal_response(
                    response,
                    &request_id,
                    &provider_id,
                )?;
            let body = match serde_json::to_vec(&response) {
                Ok(body) => body,
                Err(error) => {
                    *connection = None;
                    return Err(websocket_protocol_error(&request_id, &provider_id, error));
                }
            };
            return Ok(V3ProviderResp14Raw::from_json(
                request_id,
                provider_id,
                200,
                vec![content_type_header("application/json")],
                body,
            ));
        }
    }
}

fn content_type_header(value: &str) -> V3ProviderResponseHeader {
    V3ProviderResponseHeader {
        name: "content-type".to_string(),
        value: value.as_bytes().to_vec(),
    }
}

fn ensure_not_cancelled(
    request_id: &str,
    provider_id: &str,
    cancellation: Option<&V3ProviderCancellation>,
) -> Result<(), V3ProviderError> {
    if cancellation.is_some_and(V3ProviderCancellation::is_cancelled) {
        return Err(V3ProviderError::ClientDisconnect {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
        });
    }
    Ok(())
}

async fn read_response_body_bytes(
    response: reqwest::Response,
    request_id: &str,
    provider_id: &str,
    cancellation: Option<V3ProviderCancellation>,
) -> Result<Vec<u8>, V3ProviderError> {
    let read = response.bytes();
    let bytes = match cancellation {
        Some(cancellation) => {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    return Err(V3ProviderError::ClientDisconnect {
                        request_id: request_id.to_string(),
                        provider_id: provider_id.to_string(),
                    });
                }
                bytes = read => bytes,
            }
        }
        None => read.await,
    }
    .map_err(|error| V3ProviderError::ResponseBody {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: error.to_string(),
    })?;
    Ok(bytes.to_vec())
}

async fn resolve_secret(
    request_id: &str,
    provider_id: &str,
    auth: &V3ProviderAuthHandle,
) -> Result<String, V3ProviderError> {
    let secret = match &auth.secret {
        V3ProviderAuthSecretHandle::Environment(name) => {
            std::env::var(name).map_err(|_| V3ProviderError::MissingAuthSecret {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                auth_alias: auth.alias.clone(),
            })?
        }
        V3ProviderAuthSecretHandle::TokenFile(path) => tokio::fs::read_to_string(path)
            .await
            .map_err(|error| V3ProviderError::AuthSecretRead {
                request_id: request_id.to_string(),
                provider_id: provider_id.to_string(),
                auth_alias: auth.alias.clone(),
                reason: error.to_string(),
            })?,
        V3ProviderAuthSecretHandle::ApiKey(value) => expand_env_vars(value),
    };
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        return Err(V3ProviderError::MissingAuthSecret {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            auth_alias: auth.alias.clone(),
        });
    }
    Ok(secret)
}

fn expand_env_vars(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != b'}' {
                j += 1;
            }
            if j < bytes.len() {
                let inner = &input[i + 2..j];
                let (var_name, default_val) = if let Some(dash_pos) = inner.find(":-") {
                    (&inner[..dash_pos], Some(&inner[dash_pos + 2..]))
                } else {
                    (inner, None)
                };
                let env_val = std::env::var(var_name).ok().unwrap_or_default();
                let replacement = if env_val.is_empty() {
                    default_val.unwrap_or("")
                } else {
                    &env_val
                };
                result.push_str(replacement);
                i = j + 1;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

#[cfg(test)]
mod tests;
