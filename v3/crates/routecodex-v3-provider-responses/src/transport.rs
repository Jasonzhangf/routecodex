use crate::raw_response::{V3ProviderResp14Raw, V3ProviderSseStream};
use crate::shared::{collect_response_headers, content_type, validated_sse_stream};
use crate::wire::{
    V3Provider12ResponsesWirePayload, V3ProviderAuthHandle, V3ProviderAuthSecretHandle,
    V3ResponsesStreamIntent,
};
use crate::{V3ProviderError, V3ProviderHttpFailure, V3ProviderResponseHeader};
use async_trait::async_trait;
use futures_util::{stream, SinkExt, StreamExt};
use routecodex_v3_config::V3ResponsesTransportKind;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Notify, OwnedMutexGuard};
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

const OPENAI_BETA_HEADER: &str = "openai-beta";
const RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE: &str = "responses_websockets=2026-02-06";
const V3_RESPONSES_WEBSOCKET_PROTOCOL_AGGREGATION_OWNER: &str =
    "V3ProviderResponsesWebSocketSession -> V3ProviderResp14Raw";

#[derive(Clone, Default)]
pub struct V3ProviderCancellation {
    inner: Arc<V3ProviderCancellationInner>,
}

#[derive(Default)]
struct V3ProviderCancellationInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl fmt::Debug for V3ProviderCancellation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("V3ProviderCancellation")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl V3ProviderCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
        self.inner.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        let notified = self.inner.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

#[derive(Debug)]
enum V3Transport13ResponsesRequestKind {
    Http {
        request_id: String,
        provider_id: String,
        url: reqwest::Url,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        body: Value,
        cancellation: Option<V3ProviderCancellation>,
    },
    AnthropicMessagesHttp {
        request_id: String,
        provider_id: String,
        url: reqwest::Url,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        body: Value,
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
        cancellation: Option<V3ProviderCancellation>,
    },
}

#[derive(Debug)]
pub struct V3Transport13ResponsesRequest {
    _sealed: (),
    kind: V3Transport13ResponsesRequestKind,
}

pub type V3Transport13ResponsesHttpRequest = V3Transport13ResponsesRequest;

impl V3Transport13ResponsesRequest {
    pub fn request_id(&self) -> &str {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { request_id, .. }
            | V3Transport13ResponsesRequestKind::AnthropicMessagesHttp { request_id, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { request_id, .. } => request_id,
        }
    }

    pub fn provider_id(&self) -> &str {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { provider_id, .. }
            | V3Transport13ResponsesRequestKind::AnthropicMessagesHttp { provider_id, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { provider_id, .. } => provider_id,
        }
    }

    pub fn url(&self) -> &str {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { url, .. }
            | V3Transport13ResponsesRequestKind::AnthropicMessagesHttp { url, .. } => url.as_str(),
            V3Transport13ResponsesRequestKind::WebSocketV2 { url, .. } => url,
        }
    }

    pub fn body(&self) -> &Value {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { body, .. }
            | V3Transport13ResponsesRequestKind::AnthropicMessagesHttp { body, .. } => body,
            V3Transport13ResponsesRequestKind::WebSocketV2 { event, .. } => event,
        }
    }

    pub fn stream_intent(&self) -> V3ResponsesStreamIntent {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { stream_intent, .. }
            | V3Transport13ResponsesRequestKind::AnthropicMessagesHttp { stream_intent, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { stream_intent, .. } => {
                *stream_intent
            }
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
                "headers": {
                    "accept": if self.stream_intent() == V3ResponsesStreamIntent::Sse { "text/event-stream" } else { "application/json" },
                    "authorization": "[REDACTED]",
                    "content-type": "application/json"
                },
                "body": self.body(),
                "streamIntent": stream_intent
            }),
            V3Transport13ResponsesRequestKind::AnthropicMessagesHttp { .. } => json!({
                "method": "POST",
                "providerId": self.provider_id(),
                "url": self.url(),
                "headers": {
                    "accept": if self.stream_intent() == V3ResponsesStreamIntent::Sse { "text/event-stream" } else { "application/json" },
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                    "x-api-key": "[REDACTED]"
                },
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
            | V3Transport13ResponsesRequestKind::AnthropicMessagesHttp { cancellation, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { cancellation, .. } => {
                *cancellation = Some(value);
            }
        }
        self
    }
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
    match target.responses_transport {
        V3ResponsesTransportKind::Http => {
            if target.provider_type.eq_ignore_ascii_case("anthropic") {
                let mut body = body;
                lift_responses_additional_tools_for_anthropic_messages_body(
                    &request_id,
                    &provider_id,
                    &mut body,
                )?;
                let body = build_anthropic_messages_body(&request_id, &provider_id, body)?;
                let url_text = anthropic_messages_url(&target.base_url);
                let url = reqwest::Url::parse(&url_text).map_err(|error| {
                    V3ProviderError::InvalidBaseUrl {
                        request_id: request_id.clone(),
                        provider_id: provider_id.clone(),
                        reason: error.to_string(),
                    }
                })?;
                return Ok(v3_transport_13_request(
                    V3Transport13ResponsesRequestKind::AnthropicMessagesHttp {
                        request_id,
                        provider_id,
                        url,
                        auth: target.auth,
                        stream_intent,
                        body,
                        cancellation: None,
                    },
                ));
            }
            let url_text = format!("{}/responses", target.base_url.trim_end_matches('/'));
            build_v3_transport_13_responses_http_request_from_parts(
                request_id,
                provider_id,
                url_text,
                target.auth,
                stream_intent,
                body,
            )
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
                    cancellation: None,
                },
            ))
        }
    }
}

fn lift_responses_additional_tools_for_anthropic_messages_body(
    request_id: &str,
    provider_id: &str,
    body: &mut Value,
) -> Result<(), V3ProviderError> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| V3ProviderError::InvalidWireBody {
            request_id: request_id.to_string(),
        })?;
    let Some(input) = object.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let original_input = std::mem::take(input);
    let mut next_input = Vec::with_capacity(original_input.len());
    let mut lifted_tools = Vec::new();
    for item in original_input {
        if item.get("type").and_then(Value::as_str) != Some("additional_tools") {
            next_input.push(item);
            continue;
        }
        let tools = item.get("tools").and_then(Value::as_array).ok_or_else(|| {
            provider_protocol_error(
                request_id,
                provider_id,
                "Anthropic Messages protocol conversion requires additional_tools.tools array",
            )
        })?;
        lifted_tools.extend(tools.iter().cloned());
    }
    *input = next_input;
    if lifted_tools.is_empty() {
        return Ok(());
    }
    let tools_value = object
        .entry("tools".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let tools = tools_value.as_array_mut().ok_or_else(|| {
        provider_protocol_error(
            request_id,
            provider_id,
            "Anthropic Messages protocol conversion requires tools array",
        )
    })?;
    tools.extend(lifted_tools);
    Ok(())
}

pub fn build_v3_transport_13_responses_http_request_from_parts(
    request_id: impl Into<String>,
    provider_id: impl Into<String>,
    url_text: impl AsRef<str>,
    auth: V3ProviderAuthHandle,
    stream_intent: V3ResponsesStreamIntent,
    body: Value,
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
        Self {
            client: reqwest::Client::new(),
            websocket_sessions: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}

pub type ReqwestResponsesTransport = ProviderResponsesTransport;

#[async_trait]
impl ResponsesTransport for ProviderResponsesTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        match request.kind {
            V3Transport13ResponsesRequestKind::Http {
                request_id,
                provider_id,
                url,
                auth,
                stream_intent,
                body,
                cancellation,
            } => {
                self.send_http(
                    request_id,
                    provider_id,
                    url,
                    auth,
                    stream_intent,
                    body,
                    cancellation,
                )
                .await
            }
            V3Transport13ResponsesRequestKind::AnthropicMessagesHttp {
                request_id,
                provider_id,
                url,
                auth,
                stream_intent,
                body,
                cancellation,
            } => {
                self.send_anthropic_messages_http(
                    request_id,
                    provider_id,
                    url,
                    auth,
                    stream_intent,
                    body,
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
        }
    }
}

impl ProviderResponsesTransport {
    #[allow(clippy::too_many_arguments)]
    async fn send_anthropic_messages_http(
        &self,
        request_id: String,
        provider_id: String,
        url: reqwest::Url,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        body: Value,
        cancellation: Option<V3ProviderCancellation>,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        ensure_not_cancelled(&request_id, &provider_id, cancellation.as_ref())?;
        let secret = resolve_secret(&request_id, &provider_id, &auth).await?;
        let accept = match stream_intent {
            V3ResponsesStreamIntent::Json => "application/json",
            V3ResponsesStreamIntent::Sse => "text/event-stream",
        };
        let send = self
            .client
            .post(url)
            .header(reqwest::header::ACCEPT, accept)
            .header("x-api-key", secret)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send();
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
        let response_headers = collect_response_headers(response.headers());
        let response_content_type = content_type(response.headers());
        if status >= 400 {
            let body =
                read_response_body_bytes(response, &request_id, &provider_id, cancellation.clone())
                    .await?;
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id,
                    provider_id,
                    status,
                    headers: response_headers,
                    body,
                }),
            });
        }

        match stream_intent {
            V3ResponsesStreamIntent::Json
                if response_content_type
                    .as_deref()
                    .is_some_and(|value| value.starts_with("application/json")) =>
            {
                let body =
                    read_response_body_bytes(response, &request_id, &provider_id, cancellation)
                        .await?;
                let projected =
                    project_anthropic_message_json_to_responses(&request_id, &provider_id, &body)?;
                Ok(V3ProviderResp14Raw::from_json(
                    request_id,
                    provider_id,
                    status,
                    vec![content_type_header("application/json")],
                    projected,
                ))
            }
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
                    request_id.clone(),
                    provider_id.clone(),
                    status,
                    vec![content_type_header("text/event-stream")],
                    project_anthropic_sse_to_responses(stream, request_id, provider_id),
                ))
            }
            V3ResponsesStreamIntent::Json => Err(V3ProviderError::UnexpectedContentType {
                request_id,
                provider_id,
                expected: "JSON",
                content_type: response_content_type,
            }),
            V3ResponsesStreamIntent::Sse => Err(V3ProviderError::UnexpectedContentType {
                request_id,
                provider_id,
                expected: "SSE",
                content_type: response_content_type,
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_http(
        &self,
        request_id: String,
        provider_id: String,
        url: reqwest::Url,
        auth: V3ProviderAuthHandle,
        stream_intent: V3ResponsesStreamIntent,
        body: Value,
        cancellation: Option<V3ProviderCancellation>,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        ensure_not_cancelled(&request_id, &provider_id, cancellation.as_ref())?;
        let secret = resolve_secret(&request_id, &provider_id, &auth).await?;
        let accept = match stream_intent {
            V3ResponsesStreamIntent::Json => "application/json",
            V3ResponsesStreamIntent::Sse => "text/event-stream",
        };
        let send = self
            .client
            .post(url)
            .header(reqwest::header::ACCEPT, accept)
            .bearer_auth(secret)
            .json(&body)
            .send();
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
            let body =
                read_response_body_bytes(response, &request_id, &provider_id, cancellation.clone())
                    .await?;
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

        match stream_intent {
            V3ResponsesStreamIntent::Json
                if response_content_type
                    .as_deref()
                    .is_some_and(|value| value.starts_with("application/json")) =>
            {
                let body =
                    read_response_body_bytes(response, &request_id, &provider_id, cancellation)
                        .await?;
                Ok(V3ProviderResp14Raw::from_json(
                    request_id,
                    provider_id,
                    status,
                    headers,
                    body,
                ))
            }
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
            V3ResponsesStreamIntent::Json => Err(V3ProviderError::UnexpectedContentType {
                request_id,
                provider_id,
                expected: "JSON",
                content_type: response_content_type,
            }),
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
                websocket_sse_stream(connection, request_id, provider_id, cancellation),
            ));
        }

        let mut json_events = V3ResponsesWebSocketProtocolAggregate::default();
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

#[derive(Default)]
struct V3ResponsesWebSocketProtocolAggregate {
    function_call_items: BTreeMap<u64, Value>,
}

impl V3ResponsesWebSocketProtocolAggregate {
    fn record(
        &mut self,
        event_type: &str,
        event: &Value,
        request_id: &str,
        provider_id: &str,
    ) -> Result<(), V3ProviderError> {
        match event_type {
            "response.output_item.added" | "response.output_item.done" => {
                let Some(item) = event.get("item") else {
                    return Err(websocket_protocol_error(
                        request_id,
                        provider_id,
                        format!("{event_type} is missing item"),
                    ));
                };
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let output_index =
                        websocket_output_index(event, event_type, request_id, provider_id)?;
                    self.function_call_items.insert(output_index, item.clone());
                }
            }
            "response.function_call_arguments.delta" => {
                let output_index =
                    websocket_output_index(event, event_type, request_id, provider_id)?;
                let delta = event.get("delta").and_then(Value::as_str).ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "response.function_call_arguments.delta is missing delta",
                    )
                })?;
                let item = self
                    .function_call_items
                    .get_mut(&output_index)
                    .ok_or_else(|| {
                        websocket_protocol_error(
                            request_id,
                            provider_id,
                            "response.function_call_arguments.delta arrived before function_call output_item",
                        )
                    })?;
                let object = item.as_object_mut().ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "function_call output_item is not an object",
                    )
                })?;
                let current = object
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                object.insert(
                    "arguments".to_string(),
                    Value::String(format!("{current}{delta}")),
                );
            }
            "response.function_call_arguments.done" => {
                let output_index =
                    websocket_output_index(event, event_type, request_id, provider_id)?;
                let arguments =
                    event
                        .get("arguments")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            websocket_protocol_error(
                                request_id,
                                provider_id,
                                "response.function_call_arguments.done is missing arguments",
                            )
                        })?;
                let item = self
                    .function_call_items
                    .get_mut(&output_index)
                    .ok_or_else(|| {
                        websocket_protocol_error(
                            request_id,
                            provider_id,
                            "response.function_call_arguments.done arrived before function_call output_item",
                        )
                    })?;
                let object = item.as_object_mut().ok_or_else(|| {
                    websocket_protocol_error(
                        request_id,
                        provider_id,
                        "function_call output_item is not an object",
                    )
                })?;
                object.insert(
                    "arguments".to_string(),
                    Value::String(arguments.to_string()),
                );
            }
            _ => {}
        }
        Ok(())
    }

    fn apply_responses_websocket_protocol_events_to_terminal_response(
        &self,
        response: &Value,
        request_id: &str,
        provider_id: &str,
    ) -> Result<Value, V3ProviderError> {
        let _owner = V3_RESPONSES_WEBSOCKET_PROTOCOL_AGGREGATION_OWNER;
        let has_terminal_output = response
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|output| !output.is_empty());
        if has_terminal_output || self.function_call_items.is_empty() {
            return Ok(response.clone());
        }

        let source = response.as_object().ok_or_else(|| {
            websocket_protocol_error(
                request_id,
                provider_id,
                "response.completed response is not an object",
            )
        })?;
        let mut projected = Value::Object(source.clone());
        let object = projected.as_object_mut().ok_or_else(|| {
            websocket_protocol_error(
                request_id,
                provider_id,
                "response.completed response is not an object",
            )
        })?;
        object.insert(
            "output".to_string(),
            Value::Array(self.function_call_items.values().cloned().collect()),
        );
        Ok(projected)
    }
}

fn websocket_output_index(
    event: &Value,
    event_type: &str,
    request_id: &str,
    provider_id: &str,
) -> Result<u64, V3ProviderError> {
    event
        .get("output_index")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            websocket_protocol_error(
                request_id,
                provider_id,
                format!("{event_type} is missing output_index"),
            )
        })
}

fn anthropic_messages_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1/messages") {
        base.to_string()
    } else {
        format!("{base}/v1/messages")
    }
}

fn build_anthropic_messages_body(
    request_id: &str,
    provider_id: &str,
    body: Value,
) -> Result<Value, V3ProviderError> {
    let source = body
        .as_object()
        .ok_or_else(|| V3ProviderError::InvalidWireBody {
            request_id: request_id.to_string(),
        })?;
    let mut out = Map::new();
    let model = source
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| provider_protocol_error(request_id, provider_id, "missing model"))?;
    out.insert("model".to_string(), Value::String(model.to_string()));
    if let Some(system) = source
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        out.insert("system".to_string(), Value::String(system.to_string()));
    }
    if let Some(max_tokens) = source.get("max_output_tokens").cloned() {
        out.insert("max_tokens".to_string(), max_tokens);
    }
    if let Some(stream) = source.get("stream").cloned() {
        out.insert("stream".to_string(), stream);
    }
    let messages = build_anthropic_messages(source.get("input"));
    if messages.as_array().is_none_or(Vec::is_empty) {
        return Err(provider_protocol_error(
            request_id,
            provider_id,
            "Anthropic Messages request requires at least one message",
        ));
    }
    out.insert("messages".to_string(), messages);
    if let Some(tools) = build_anthropic_tools(source.get("tools")) {
        out.insert("tools".to_string(), tools);
    }
    if let Some(tool_choice) = build_anthropic_tool_choice(source.get("tool_choice")) {
        out.insert("tool_choice".to_string(), tool_choice);
    }
    Ok(Value::Object(out))
}

fn build_anthropic_messages(input: Option<&Value>) -> Value {
    let Some(input) = input else {
        return json!([]);
    };
    match input {
        Value::String(text) => json!([{
            "role": "user",
            "content": [{"type": "text", "text": text}]
        }]),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .filter_map(anthropic_message_from_responses_item)
                .collect(),
        ),
        _ => json!([]),
    }
}

fn anthropic_message_from_responses_item(item: &Value) -> Option<Value> {
    let object = item.as_object()?;
    match object.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            Some(json!({
                "role": if role == "assistant" { "assistant" } else { "user" },
                "content": anthropic_content_parts(object.get("content"))
            }))
        }
        Some("function_call" | "custom_tool_call" | "tool_call") => Some(json!({
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": object.get("call_id").or_else(|| object.get("id")).and_then(Value::as_str).unwrap_or("call_0"),
                "name": object.get("name").and_then(Value::as_str).unwrap_or("tool"),
                "input": anthropic_tool_use_input(object)
            }]
        })),
        Some("function_call_output" | "custom_tool_call_output" | "tool_call_output") => {
            Some(json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": object.get("call_id").and_then(Value::as_str).unwrap_or("call_0"),
                    "content": object.get("output").cloned().unwrap_or_else(|| Value::String(String::new()))
                }]
            }))
        }
        None if object.get("role").is_some() || object.get("content").is_some() => {
            let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
            Some(json!({
                "role": if role == "assistant" { "assistant" } else { "user" },
                "content": anthropic_content_parts(object.get("content"))
            }))
        }
        _ => None,
    }
}

fn anthropic_tool_use_input(object: &Map<String, Value>) -> Value {
    if let Some(arguments) = parse_json_string_or_clone(object.get("arguments")) {
        return arguments;
    }
    if let Some(input) = parse_json_string_or_clone(object.get("input")) {
        return match input {
            Value::String(text) => json!({"input": text}),
            other => other,
        };
    }
    json!({})
}

fn anthropic_content_parts(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => json!([{"type":"text","text":text}]),
        Some(Value::Array(parts)) => Value::Array(
            parts
                .iter()
                .filter_map(|part| {
                    let kind = part.get("type").and_then(Value::as_str)?;
                    match kind {
                        "input_text" | "output_text" | "text" => Some(json!({
                            "type": "text",
                            "text": part.get("text").and_then(Value::as_str).unwrap_or("")
                        })),
                        "tool_use" | "tool_result" => Some(part.clone()),
                        _ => None,
                    }
                })
                .collect(),
        ),
        _ => json!([{"type":"text","text":""}]),
    }
}

fn build_anthropic_tools(tools: Option<&Value>) -> Option<Value> {
    let tools = tools?.as_array()?;
    let converted = tools
        .iter()
        .filter_map(|tool| match tool.get("type").and_then(Value::as_str) {
            Some("function") => Some(json!({
                "name": tool.get("name").and_then(Value::as_str).unwrap_or("tool"),
                "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                "input_schema": tool.get("parameters").or_else(|| tool.get("input_schema")).cloned().unwrap_or_else(|| json!({"type":"object"}))
            })),
            Some("custom") => Some(json!({
                "name": tool.get("name").and_then(Value::as_str).unwrap_or("tool"),
                "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                "input_schema": anthropic_custom_tool_input_schema(tool.get("name").and_then(Value::as_str), tool)
            })),
            Some("web_search_preview") => Some(json!({
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 2
            })),
            Some("web_search_20250305") => Some(tool.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if converted.is_empty() {
        None
    } else {
        Some(Value::Array(converted))
    }
}

fn anthropic_custom_tool_input_schema(name: Option<&str>, tool: &Value) -> Value {
    if let Some(schema) = tool.get("parameters").or_else(|| tool.get("input_schema")) {
        return schema.clone();
    }
    if name
        .map(str::trim)
        .is_some_and(|name| name.eq_ignore_ascii_case("apply_patch"))
    {
        json!({
                "type":"object",
                "properties":{"patch":{
                    "type":"string",
                    "description":"Raw apply_patch text. Send canonical *** Begin Patch / *** End Patch grammar as a single string. Put workspace-relative paths inside patch headers such as *** Add File: tmp/example.txt or *** Update File: src/main.ts. For temporary tests, use tmp/... inside the workspace, not /tmp/.... Do not use absolute paths."
                }},
                "required":["patch"],
                "additionalProperties":true
        })
    } else {
        json!({
            "type":"object",
            "properties":{},
            "additionalProperties":true
        })
    }
}

fn build_anthropic_tool_choice(tool_choice: Option<&Value>) -> Option<Value> {
    let tool_choice = tool_choice?;
    match tool_choice {
        Value::String(name) if !name.trim().is_empty() => {
            Some(json!({"type":"tool","name":name.trim()}))
        }
        Value::Object(object) => {
            let choice_type = object.get("type").and_then(Value::as_str)?;
            match choice_type {
                "auto" | "any" | "none" => Some(json!({"type":choice_type})),
                "custom" => object
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map(|name| json!({"type":"custom","name":name.trim()})),
                "function" | "tool" => object
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .map(|name| json!({"type":"tool","name":name.trim()})),
                _ => None,
            }
        }
        _ => None,
    }
}

fn parse_json_string_or_clone(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(text) => serde_json::from_str(text)
            .ok()
            .or_else(|| Some(Value::String(text.clone()))),
        other => Some(other.clone()),
    }
}

fn project_anthropic_message_json_to_responses(
    request_id: &str,
    provider_id: &str,
    body: &[u8],
) -> Result<Vec<u8>, V3ProviderError> {
    let message: Value =
        serde_json::from_slice(body).map_err(|error| V3ProviderError::ResponseBody {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: error.to_string(),
        })?;
    let projected =
        project_anthropic_message_to_responses_value(&message, request_id, provider_id)?;
    serde_json::to_vec(&projected).map_err(|error| V3ProviderError::ResponseBody {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: error.to_string(),
    })
}

fn project_anthropic_message_to_responses_value(
    message: &Value,
    request_id: &str,
    provider_id: &str,
) -> Result<Value, V3ProviderError> {
    let content = message
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            provider_protocol_error(
                request_id,
                provider_id,
                "anthropic response missing content",
            )
        })?;
    let mut output = Vec::new();
    let mut text_parts = Vec::new();
    let mut output_text = String::new();
    let mut has_tool_use = false;
    for part in content {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = part.get("text").and_then(Value::as_str).unwrap_or("");
                if !text.is_empty() {
                    output_text.push_str(text);
                    text_parts.push(json!({"type":"output_text","text":text}));
                }
            }
            Some("tool_use") => {
                has_tool_use = true;
                output.push(json!({
                    "type": "function_call",
                    "call_id": part.get("id").and_then(Value::as_str).unwrap_or("call_0"),
                    "name": part.get("name").and_then(Value::as_str).unwrap_or("tool"),
                    "arguments": serde_json::to_string(part.get("input").unwrap_or(&json!({}))).unwrap_or_else(|_| "{}".to_string())
                }));
            }
            _ => {}
        }
    }
    if !text_parts.is_empty() {
        output.insert(
            0,
            json!({
                "type": "message",
                "role": "assistant",
                "content": text_parts
            }),
        );
    }
    let status =
        if has_tool_use || message.get("stop_reason").and_then(Value::as_str) == Some("tool_use") {
            "requires_action"
        } else {
            "completed"
        };
    Ok(json!({
        "id": format!("resp_{}", message.get("id").and_then(Value::as_str).unwrap_or(request_id)),
        "object": "response",
        "status": status,
        "model": message.get("model").cloned().unwrap_or(Value::Null),
        "output": output,
        "output_text": output_text,
        "usage": project_anthropic_usage(message.get("usage"))
    }))
}

fn project_anthropic_usage(usage: Option<&Value>) -> Value {
    let input = usage
        .and_then(|usage| usage.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .and_then(|usage| usage.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    json!({
        "input_tokens": input,
        "output_tokens": output,
        "total_tokens": input + output
    })
}

struct AnthropicSseProjectionState {
    source: V3ProviderSseStream,
    ready: VecDeque<Vec<u8>>,
    request_id: String,
    provider_id: String,
    response_id: String,
    model: String,
    output_text: String,
    text_started: bool,
    active_tool_blocks: BTreeMap<u64, AnthropicSseToolBlock>,
    completed_tool_items: Vec<Value>,
    stop_reason: Option<String>,
    usage: Option<Value>,
    finished: bool,
}

struct AnthropicSseToolBlock {
    call_id: String,
    name: String,
    initial_input: Value,
    partial_json: String,
}

fn project_anthropic_sse_to_responses(
    source: V3ProviderSseStream,
    request_id: String,
    provider_id: String,
) -> V3ProviderSseStream {
    let state = AnthropicSseProjectionState {
        source,
        ready: VecDeque::new(),
        request_id,
        provider_id,
        response_id: "resp_anthropic_stream".to_string(),
        model: String::new(),
        output_text: String::new(),
        text_started: false,
        active_tool_blocks: BTreeMap::new(),
        completed_tool_items: Vec::new(),
        stop_reason: None,
        usage: None,
        finished: false,
    };
    Box::pin(stream::unfold(state, |mut state| async move {
        loop {
            if let Some(frame) = state.ready.pop_front() {
                return Some((Ok(frame), state));
            }
            if state.finished {
                return None;
            }
            let next = state.source.next().await?;
            let frame = match next {
                Ok(frame) => frame,
                Err(error) => {
                    state.finished = true;
                    return Some((Err(error), state));
                }
            };
            let event = match parse_sse_data_json(&frame, &state.request_id, &state.provider_id) {
                Ok(Some(event)) => event,
                Ok(None) => continue,
                Err(error) => {
                    state.finished = true;
                    return Some((Err(error), state));
                }
            };
            if let Err(error) = project_anthropic_sse_event(&mut state, &event) {
                state.finished = true;
                return Some((Err(error), state));
            }
        }
    }))
}

fn project_anthropic_sse_event(
    state: &mut AnthropicSseProjectionState,
    event: &Value,
) -> Result<(), V3ProviderError> {
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            let message = event.get("message").unwrap_or(&Value::Null);
            state.response_id = format!(
                "resp_{}",
                message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("anthropic_stream")
            );
            state.model = message
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            state.ready.push_back(sse_json_frame(
                "response.created",
                json!({
                    "type": "response.created",
                    "response": base_stream_response(state, "in_progress")
                }),
            )?);
        }
        Some("content_block_start") => project_anthropic_sse_content_block_start(state, event)?,
        Some("content_block_delta") => {
            if let Some(text) = event
                .get("delta")
                .and_then(|delta| delta.get("text"))
                .and_then(Value::as_str)
            {
                state.output_text.push_str(text);
                state.ready.push_back(sse_json_frame(
                    "response.output_text.delta",
                    json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":text}),
                )?);
            }
            if event
                .get("delta")
                .and_then(|delta| delta.get("type"))
                .and_then(Value::as_str)
                == Some("input_json_delta")
            {
                let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
                if let Some(block) = state.active_tool_blocks.get_mut(&index) {
                    if let Some(partial_json) = event
                        .get("delta")
                        .and_then(|delta| delta.get("partial_json"))
                        .and_then(Value::as_str)
                    {
                        block.partial_json.push_str(partial_json);
                    }
                }
            }
        }
        Some("content_block_stop") => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
            if let Some(block) = state.active_tool_blocks.remove(&index) {
                let item = anthropic_sse_tool_block_to_responses_item(block);
                state.completed_tool_items.push(item.clone());
                state.ready.push_back(sse_json_frame(
                    "response.output_item.done",
                    json!({"type":"response.output_item.done","output_index":index,"item":item}),
                )?);
            }
        }
        Some("message_stop") => {
            if state.text_started {
                state.ready.push_back(sse_json_frame(
                    "response.output_text.done",
                    json!({"type":"response.output_text.done","output_index":0,"content_index":0,"text":state.output_text}),
                )?);
            }
            let status = anthropic_sse_response_status(state);
            state.ready.push_back(sse_json_frame(
                "response.completed",
                json!({"type":"response.completed","response":base_stream_response(state, status)}),
            )?);
            state.ready.push_back(sse_json_frame(
                "response.done",
                json!({"type":"response.done","response":base_stream_response(state, status)}),
            )?);
            state.ready.push_back(b"data: [DONE]\n\n".to_vec());
            state.finished = true;
        }
        Some("message_delta") => {
            state.stop_reason = event
                .get("delta")
                .and_then(|delta| delta.get("stop_reason"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(usage) = project_anthropic_usage_optional(event.get("usage")) {
                state.usage = Some(usage);
            }
        }
        Some("ping") => {}
        Some("error") => {
            return Err(provider_protocol_error(
                &state.request_id,
                &state.provider_id,
                "anthropic SSE provider error",
            ));
        }
        _ => {
            return Err(provider_protocol_error(
                &state.request_id,
                &state.provider_id,
                "unsupported anthropic SSE event",
            ));
        }
    }
    Ok(())
}

fn project_anthropic_sse_content_block_start(
    state: &mut AnthropicSseProjectionState,
    event: &Value,
) -> Result<(), V3ProviderError> {
    let block = event.get("content_block").unwrap_or(&Value::Null);
    match block.get("type").and_then(Value::as_str) {
        Some("text") if !state.text_started => {
            state.text_started = true;
            state.ready.push_back(sse_json_frame(
                "response.output_item.added",
                json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","content":[]}}),
            )?);
            state.ready.push_back(sse_json_frame(
                "response.content_part.added",
                json!({"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}),
            )?);
        }
        Some("tool_use") => {
            let index = event.get("index").and_then(Value::as_u64).unwrap_or(0);
            let call_id = block
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("call_0")
                .to_string();
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("tool")
                .to_string();
            state.active_tool_blocks.insert(
                index,
                AnthropicSseToolBlock {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    initial_input: block.get("input").cloned().unwrap_or_else(|| json!({})),
                    partial_json: String::new(),
                },
            );
            state.ready.push_back(sse_json_frame(
                "response.output_item.added",
                if name == "apply_patch" {
                    json!({
                        "type":"response.output_item.added",
                        "output_index":index,
                        "item":{"type":"custom_tool_call","call_id":call_id,"name":name,"input":""}
                    })
                } else {
                    json!({
                        "type":"response.output_item.added",
                        "output_index":index,
                        "item":{"type":"function_call","call_id":call_id,"name":name,"arguments":""}
                    })
                },
            )?);
        }
        _ => {}
    }
    Ok(())
}

fn anthropic_sse_tool_block_to_responses_item(block: AnthropicSseToolBlock) -> Value {
    let arguments = if block.partial_json.is_empty() {
        serde_json::to_string(&block.initial_input).unwrap_or_else(|_| "{}".to_string())
    } else {
        block.partial_json
    };
    if block.name == "apply_patch" {
        return json!({
            "type":"custom_tool_call",
            "call_id":block.call_id,
            "name":block.name,
            "input":anthropic_apply_patch_freeform_input_from_arguments(&arguments)
        });
    }
    json!({
        "type":"function_call",
        "call_id":block.call_id,
        "name":block.name,
        "arguments":arguments
    })
}

fn anthropic_apply_patch_freeform_input_from_arguments(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("patch")
                .or_else(|| value.get("input"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| arguments.to_string())
}

fn anthropic_sse_response_status(state: &AnthropicSseProjectionState) -> &'static str {
    if !state.completed_tool_items.is_empty()
        || state.stop_reason.as_deref() == Some("tool_use")
        || !state.active_tool_blocks.is_empty()
    {
        "requires_action"
    } else {
        "completed"
    }
}

fn base_stream_response(state: &AnthropicSseProjectionState, status: &str) -> Value {
    let mut output = Vec::new();
    if state.text_started || !state.output_text.is_empty() {
        output.push(json!({
            "type": "message",
            "role": "assistant",
            "content": [{"type":"output_text","text":state.output_text}]
        }));
    }
    output.extend(state.completed_tool_items.iter().cloned());
    let mut response = json!({
        "id": state.response_id,
        "object": "response",
        "status": status,
        "model": state.model,
        "output": output,
        "output_text": state.output_text
    });
    if let Some(usage) = &state.usage {
        response["usage"] = usage.clone();
    }
    response
}

fn project_anthropic_usage_optional(usage: Option<&Value>) -> Option<Value> {
    let usage = usage?;
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .get("cache_read_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(json!({
        "input_tokens": input,
        "input_tokens_details": {"cached_tokens": cached},
        "output_tokens": output,
        "total_tokens": input + output
    }))
}

fn parse_sse_data_json(
    frame: &[u8],
    request_id: &str,
    provider_id: &str,
) -> Result<Option<Value>, V3ProviderError> {
    let text = std::str::from_utf8(frame).map_err(|error| V3ProviderError::MalformedSse {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: error.to_string(),
    })?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() || data == "[DONE]" {
        return Ok(None);
    }
    serde_json::from_str(&data)
        .map(Some)
        .map_err(|error| V3ProviderError::MalformedSse {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            reason: error.to_string(),
        })
}

fn sse_json_frame(event: &str, data: Value) -> Result<Vec<u8>, V3ProviderError> {
    let data = serde_json::to_string(&data).map_err(|error| V3ProviderError::ResponseBody {
        request_id: "sse_projection".to_string(),
        provider_id: "anthropic".to_string(),
        reason: error.to_string(),
    })?;
    Ok(format!("event: {event}\ndata: {data}\n\n").into_bytes())
}

fn provider_protocol_error(
    request_id: &str,
    provider_id: &str,
    reason: impl Into<String>,
) -> V3ProviderError {
    V3ProviderError::ResponseBody {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: reason.into(),
    }
}

struct WebSocketSseState {
    connection: OwnedMutexGuard<Option<ResponsesWebSocket>>,
    request_id: String,
    provider_id: String,
    cancellation: Option<V3ProviderCancellation>,
    emit_done: bool,
    finished: bool,
}

impl Drop for WebSocketSseState {
    fn drop(&mut self) {
        if !self.finished {
            *self.connection = None;
        }
    }
}

fn websocket_sse_stream(
    connection: OwnedMutexGuard<Option<ResponsesWebSocket>>,
    request_id: String,
    provider_id: String,
    cancellation: Option<V3ProviderCancellation>,
) -> V3ProviderSseStream {
    let state = WebSocketSseState {
        connection,
        request_id,
        provider_id,
        cancellation,
        emit_done: false,
        finished: false,
    };
    Box::pin(stream::unfold(state, |mut state| async move {
        loop {
            if state.emit_done {
                state.emit_done = false;
                state.finished = true;
                return Some((Ok(b"data: [DONE]\n\n".to_vec()), state));
            }
            if state.finished {
                return None;
            }

            let next = match state.connection.as_mut() {
                Some(socket) => {
                    next_websocket_message(
                        socket,
                        state.cancellation.clone(),
                        &state.request_id,
                        &state.provider_id,
                    )
                    .await
                }
                None => Err(websocket_protocol_error(
                    &state.request_id,
                    &state.provider_id,
                    "WebSocket session is unavailable",
                )),
            };
            let message = match next {
                Ok(Some(message)) => message,
                Ok(None) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            "connection closed before terminal response event",
                        )),
                        state,
                    ));
                }
                Err(error) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((Err(error), state));
                }
            };
            let bytes = match message {
                Message::Text(text) => text.as_bytes().to_vec(),
                Message::Binary(bytes) => bytes.to_vec(),
                Message::Ping(payload) => {
                    let result = match state.connection.as_mut() {
                        Some(socket) => socket.send(Message::Pong(payload)).await,
                        None => {
                            state.finished = true;
                            return Some((
                                Err(websocket_protocol_error(
                                    &state.request_id,
                                    &state.provider_id,
                                    "WebSocket session is unavailable",
                                )),
                                state,
                            ));
                        }
                    };
                    if let Err(error) = result {
                        *state.connection = None;
                        state.finished = true;
                        return Some((
                            Err(websocket_transport_error(
                                &state.request_id,
                                &state.provider_id,
                                error,
                            )),
                            state,
                        ));
                    }
                    continue;
                }
                Message::Pong(_) | Message::Frame(_) => continue,
                Message::Close(_) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            "connection closed before terminal response event",
                        )),
                        state,
                    ));
                }
            };
            let server_event: Value = match serde_json::from_slice(&bytes) {
                Ok(event) => event,
                Err(error) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            error,
                        )),
                        state,
                    ));
                }
            };
            let event_type = match server_event.get("type").and_then(Value::as_str) {
                Some(event_type) => event_type,
                None => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((
                        Err(websocket_protocol_error(
                            &state.request_id,
                            &state.provider_id,
                            "server event is missing type",
                        )),
                        state,
                    ));
                }
            };
            if let Some(error) = websocket_server_event_error(
                event_type,
                &server_event,
                &state.request_id,
                &state.provider_id,
            ) {
                *state.connection = None;
                state.finished = true;
                return Some((Err(error), state));
            }
            let frame = match websocket_event_to_sse(
                event_type,
                &server_event,
                &state.request_id,
                &state.provider_id,
            ) {
                Ok(frame) => frame,
                Err(error) => {
                    *state.connection = None;
                    state.finished = true;
                    return Some((Err(error), state));
                }
            };
            if event_type == "response.completed" {
                state.emit_done = true;
            }
            return Some((Ok(frame), state));
        }
    }))
}

async fn next_websocket_message(
    socket: &mut ResponsesWebSocket,
    cancellation: Option<V3ProviderCancellation>,
    request_id: &str,
    provider_id: &str,
) -> Result<Option<Message>, V3ProviderError> {
    let next = match cancellation {
        Some(cancellation) => {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    let _ = socket.close(None).await;
                    return Err(V3ProviderError::ClientDisconnect {
                        request_id: request_id.to_string(),
                        provider_id: provider_id.to_string(),
                    });
                }
                next = socket.next() => next,
            }
        }
        None => socket.next().await,
    };
    next.transpose()
        .map_err(|error| websocket_transport_error(request_id, provider_id, error))
}

fn websocket_server_event_error(
    event_type: &str,
    server_event: &Value,
    request_id: &str,
    provider_id: &str,
) -> Option<V3ProviderError> {
    if event_type == "error" {
        let error = server_event.get("error").unwrap_or(server_event);
        return Some(V3ProviderError::WebSocketProviderEvent {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            status: websocket_error_status(server_event),
            code: websocket_error_code(error),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("provider WebSocket error")
                .to_string(),
        });
    }
    if matches!(event_type, "response.failed" | "response.incomplete") {
        let response_error = server_event.pointer("/response/error");
        return Some(V3ProviderError::WebSocketProviderEvent {
            request_id: request_id.to_string(),
            provider_id: provider_id.to_string(),
            status: None,
            code: response_error
                .and_then(websocket_error_code)
                .or_else(|| Some(event_type.to_string())),
            message: server_event
                .pointer("/response/error/message")
                .or_else(|| server_event.pointer("/response/incomplete_details/reason"))
                .and_then(Value::as_str)
                .unwrap_or("provider response did not complete")
                .to_string(),
        });
    }
    None
}

fn websocket_error_status(server_event: &Value) -> Option<u16> {
    server_event
        .get("status")
        .or_else(|| server_event.get("status_code"))
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
}

fn websocket_error_code(error: &Value) -> Option<String> {
    error
        .get("code")
        .or_else(|| error.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn websocket_event_to_sse(
    event_type: &str,
    event: &Value,
    request_id: &str,
    provider_id: &str,
) -> Result<Vec<u8>, V3ProviderError> {
    let data = serde_json::to_string(event)
        .map_err(|error| websocket_protocol_error(request_id, provider_id, error))?;
    Ok(format!("event: {event_type}\ndata: {data}\n\n").into_bytes())
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

fn websocket_transport_error(
    request_id: &str,
    provider_id: &str,
    error: impl fmt::Display,
) -> V3ProviderError {
    V3ProviderError::WebSocketTransport {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: error.to_string(),
    }
}

fn websocket_protocol_error(
    request_id: &str,
    provider_id: &str,
    error: impl fmt::Display,
) -> V3ProviderError {
    V3ProviderError::WebSocketProtocol {
        request_id: request_id.to_string(),
        provider_id: provider_id.to_string(),
        reason: error.to_string(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{
        build_v3_provider_12_responses_wire_payload, V3ProviderAuthSecretHandle,
        V3ResponsesProviderTarget,
    };
    use routecodex_v3_config::V3ResponsesTransportKind;
    use serde_json::json;

    fn minimax_anthropic_target() -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: "minimax".into(),
            provider_type: "anthropic".into(),
            base_url: "https://api.minimaxi.com/anthropic/v1".into(),
            canonical_model_id: "MiniMax-M3".into(),
            wire_model: "MiniMax-M3".into(),
            auth: V3ProviderAuthHandle {
                alias: "key1".into(),
                secret: V3ProviderAuthSecretHandle::Environment("MINIMAX_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
        }
    }

    fn responses_http_target() -> V3ResponsesProviderTarget {
        V3ResponsesProviderTarget {
            provider_id: "orangeai".into(),
            provider_type: "responses".into(),
            base_url: "https://api2.orangeai.cc/v1".into(),
            canonical_model_id: "glm-5.2".into(),
            wire_model: "glm-5.2".into(),
            auth: V3ProviderAuthHandle {
                alias: "key1".into(),
                secret: V3ProviderAuthSecretHandle::Environment("ORANGEAI_KEY".into()),
            },
            responses_transport: V3ResponsesTransportKind::Http,
            websocket_v2_url: None,
        }
    }

    fn reasoning_stop_tool_fixture() -> Value {
        json!({
            "type":"function",
            "name":"reasoningStop",
            "description":"Use stop schema. Minimal continue sample. Minimal finished sample. Minimal blocked sample. Schema repair sample. stopreason=0 stopreason=1 stopreason=2",
            "parameters":{
                "type":"object",
                "properties":{
                    "stopreason":{"type":"integer","enum":[0,1,2]},
                    "reason":{"type":"string"},
                    "current_goal":{"type":"string"},
                    "has_evidence":{"type":"integer","enum":[0,1]},
                    "evidence":{"type":"string"},
                    "next_step":{"type":"string"},
                    "needs_user_input":{"type":"boolean"}
                },
                "required":["stopreason"]
            }
        })
    }

    #[test]
    fn responses_http_provider_request_preserves_additional_tools_surface() {
        let original_exec = json!({
            "type":"custom",
            "name":"exec",
            "description":"run javascript",
            "format":{"type":"grammar","syntax":"lark","definition":"start: SOURCE"}
        });
        let original_wait = json!({
            "type":"function",
            "name":"wait",
            "description":"wait for exec",
            "parameters":{"type":"object","properties":{"cell_id":{"type":"string"}}}
        });
        let reasoning_stop = reasoning_stop_tool_fixture();
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-responses-additional-tools",
            responses_http_target(),
            json!({
                "model":"client-model",
                "instructions":"stopreason reasoningStop <rcc_stop_schema>",
                "input":[
                    {
                        "type":"additional_tools",
                        "role":"developer",
                        "tools":[original_exec.clone(), original_wait.clone(), reasoning_stop.clone()]
                    },
                    {"role":"user","content":"continue"}
                ],
                "stream":true
            }),
        )
        .unwrap();
        let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
        assert_eq!(request.provider_id(), "orangeai");
        assert!(
            request.body().get("tools").is_none(),
            "request path $.tools must be absent because the original request did not contain $.tools: {}",
            request.body()
        );
        assert_eq!(request.body()["input"][0]["type"], "additional_tools");
        assert_eq!(request.body()["input"][0]["tools"][0], original_exec);
        assert_eq!(request.body()["input"][0]["tools"][1], original_wait);
        assert_eq!(request.body()["input"][0]["tools"][2], reasoning_stop);
        assert_eq!(
            request.body()["input"][0]["tools"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(request.body()["input"][1]["content"], "continue");
        assert!(request.body()["instructions"]
            .as_str()
            .unwrap()
            .contains("stopreason"));
    }

    #[test]
    fn anthropic_messages_body_lifts_stopless_tools_and_system_guidance() {
        let reasoning_stop = reasoning_stop_tool_fixture();
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-anthropic-stopless-tools",
            minimax_anthropic_target(),
            json!({
                "model":"gpt-5.5",
                "instructions":"stopreason reasoningStop <rcc_stop_schema> next_step evidence",
                "input":[
                    {
                        "type":"additional_tools",
                        "role":"developer",
                        "tools":[reasoning_stop.clone()]
                    },
                    {"role":"user","content":"continue"}
                ],
                "stream":false
            }),
        )
        .unwrap();
        let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
        assert_eq!(request.provider_id(), "minimax");
        assert_eq!(
            request.body()["system"],
            "stopreason reasoningStop <rcc_stop_schema> next_step evidence"
        );
        assert_eq!(
            request.body()["messages"],
            json!([{"role":"user","content":[{"type":"text","text":"continue"}]}])
        );
        assert_eq!(request.body()["tools"].as_array().unwrap().len(), 1);
        assert_eq!(request.body()["tools"][0]["name"], "reasoningStop");
        assert!(request.body()["tools"][0]["description"]
            .as_str()
            .unwrap()
            .contains("Minimal blocked sample"));
        assert_eq!(
            request.body()["tools"][0]["input_schema"],
            reasoning_stop["parameters"]
        );
    }

    #[test]
    fn anthropic_messages_body_preserves_responses_role_items_and_custom_tools() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-anthropic-responses",
            minimax_anthropic_target(),
            json!({
                "model":"gpt-5.5",
                "input":[{
                    "role":"user",
                    "content":"Call apply_patch exactly once"
                }],
                "tools":[{
                    "type":"custom",
                    "name":"apply_patch",
                    "description":"Use apply_patch with a raw patch payload",
                    "format":{"type":"grammar","syntax":"lark","definition":"start: patch"}
                }],
                "tool_choice":{"type":"custom","name":"apply_patch"},
                "stream":true
            }),
        )
        .unwrap();
        let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
        assert_eq!(request.provider_id(), "minimax");
        assert_eq!(request.body()["model"], "MiniMax-M3");
        assert_eq!(
            request.body()["messages"],
            json!([{
                "role":"user",
                "content":[{"type":"text","text":"Call apply_patch exactly once"}]
            }])
        );
        assert_eq!(request.body()["tools"][0]["name"], "apply_patch");
        assert_eq!(
            request.body()["tools"][0]["input_schema"],
            json!({
                "type":"object",
                "properties":{"patch":{
                    "type":"string",
                    "description":"Raw apply_patch text. Send canonical *** Begin Patch / *** End Patch grammar as a single string. Put workspace-relative paths inside patch headers such as *** Add File: tmp/example.txt or *** Update File: src/main.ts. For temporary tests, use tmp/... inside the workspace, not /tmp/.... Do not use absolute paths."
                }},
                "required":["patch"],
                "additionalProperties":true
            })
        );
        assert_eq!(
            request.body()["tool_choice"],
            json!({"type":"custom","name":"apply_patch"})
        );
    }

    #[test]
    fn anthropic_custom_tools_without_schema_do_not_receive_apply_patch_schema() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-anthropic-custom-schema",
            minimax_anthropic_target(),
            json!({
                "model":"gpt-5.5",
                "input":[{"role":"user","content":"Render a result"}],
                "tools":[{"type":"custom","name":"custom.render","description":"Render a result"}],
                "stream":false
            }),
        )
        .unwrap();
        let request = build_v3_transport_13_responses_request_from_v3_provider_12(wire).unwrap();
        assert_eq!(
            request.body()["tools"][0]["input_schema"],
            json!({
                "type":"object",
                "properties":{},
                "additionalProperties":true
            })
        );
        assert!(request.body()["tools"][0]["input_schema"]
            .get("required")
            .is_none());
    }

    #[test]
    fn anthropic_messages_body_rejects_empty_messages_before_provider_send() {
        let wire = build_v3_provider_12_responses_wire_payload(
            "req-anthropic-empty",
            minimax_anthropic_target(),
            json!({
                "model":"gpt-5.5",
                "input":[],
                "stream":true
            }),
        )
        .unwrap();

        let error = build_v3_transport_13_responses_request_from_v3_provider_12(wire)
            .expect_err("empty Anthropic messages must fail before provider transport");
        assert!(
            error
                .to_string()
                .contains("Anthropic Messages request requires at least one message"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn anthropic_sse_tool_use_projects_responses_function_call_item() {
        let patch = "*** Begin Patch\n*** Add File: tmp/a.txt\n+hello\n*** End Patch";
        let source = stream::iter([
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_tool\",\"model\":\"MiniMax-M3\"}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"I'll call it.\"}}\n\n".to_vec()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_patch_1\",\"name\":\"apply_patch\",\"input\":{}}}\n\n".to_vec()),
            Ok(format!(
                "event: content_block_delta\ndata: {}\n\n",
                serde_json::to_string(&json!({
                    "type":"content_block_delta",
                    "index":1,
                    "delta":{
                        "type":"input_json_delta",
                        "partial_json": serde_json::to_string(&json!({"patch":patch})).unwrap()
                    }
                })).unwrap()
            ).into_bytes()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"input_tokens\":7,\"output_tokens\":5,\"cache_read_input_tokens\":3}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]);
        let mut projected =
            project_anthropic_sse_to_responses(Box::pin(source), "req".into(), "minimax".into());
        let mut text = String::new();
        while let Some(chunk) = projected.next().await {
            text.push_str(&String::from_utf8(chunk.unwrap()).unwrap());
        }
        assert!(text.contains("event: response.output_item.done"));
        assert!(text.contains("\"type\":\"custom_tool_call\""));
        assert!(text.contains("\"call_id\":\"call_patch_1\""));
        assert!(text.contains("\"name\":\"apply_patch\""));
        assert!(!text.contains("\"arguments\""));
        assert!(text.contains("*** Begin Patch"));
        assert!(text.contains("\"status\":\"requires_action\""));
        assert!(text.contains("\"cached_tokens\":3"));
    }
}
