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
use serde_json::{json, Value};
use std::collections::BTreeMap;
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
            | V3Transport13ResponsesRequestKind::WebSocketV2 { request_id, .. } => request_id,
        }
    }

    pub fn provider_id(&self) -> &str {
        match &self.kind {
            V3Transport13ResponsesRequestKind::Http { provider_id, .. }
            | V3Transport13ResponsesRequestKind::WebSocketV2 { provider_id, .. } => provider_id,
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
}
