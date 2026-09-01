//! routecodex-v4-server — contract-bound server diagnostic resource owner
//! (`v4.console.terminal_output`, `v4.server.request_identity`,
//! `v4.error.raw_wire_evidence`).
//!
//! Hard boundaries:
//! - console/evidence/identity are diagnostic side-channel projections; they
//!   never become control decisions and never enter provider/client payload;
//! - request identity uses the V3-compatible shared counter state and
//!   preserves the V4 server identifier as its diagnostic prefix;
//! - wire evidence flushes only on terminal failure (EOF/error/drop), never
//!   on success paths.

use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REQUEST_RECORD_SCHEMA_VERSION: u64 = 1;
const REQUEST_ID_STATE_VERSION: u64 = 1;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener as TokioTcpListener, TcpStream as TokioTcpStream};
use tokio_util::sync::CancellationToken;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub request_id: String,
    pub server_id: String,
    pub port: u16,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub stream: Option<Box<dyn ResponseStream>>,
}

pub trait ResponseStream: Send {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, io::Error>;
}

impl HttpResponse {
    pub fn new(status: u16, content_type: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            status,
            content_type: content_type.into(),
            body,
            stream: None,
        }
    }

    pub fn json(status: u16, body: Vec<u8>) -> Self {
        Self::new(status, "application/json", body)
    }

    pub fn error(status: u16, message: impl Into<String>) -> Self {
        let body = serde_json::json!({ "error": { "message": message.into() } });
        Self::json(
            status,
            serde_json::to_vec(&body).expect("error response is serializable"),
        )
    }

    pub fn streaming(
        status: u16,
        content_type: impl Into<String>,
        stream: Box<dyn ResponseStream>,
    ) -> Self {
        Self {
            status,
            content_type: content_type.into(),
            body: Vec::new(),
            stream: Some(stream),
        }
    }
}

pub trait HttpHandler {
    fn handle(&mut self, request: HttpRequest) -> HttpResponse;
}

/// V3-compatible per-listener JSONL request record projection.
/// Records are diagnostic side-channel data; request/response payloads never
/// flow through this store.
pub fn persist_request_record(request: &HttpRequest, status: u16) -> Result<(), String> {
    persist_request_record_fields(
        &request.request_id,
        &request.server_id,
        request.port,
        &request.path,
        status,
    )
}

fn persist_request_record_fields(
    request_id: &str,
    server_id: &str,
    port: u16,
    endpoint: &str,
    status: u16,
) -> Result<(), String> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "HOME is required for request record persistence".to_string())?;
    let path = home
        .join(".rcc/logs")
        .join(format!("server-v4-{port}.request-records.jsonl"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    let result = if (200..400).contains(&status) {
        "success"
    } else {
        "error"
    };
    let row = serde_json::json!({
        "request_key": format!("{port}:{request_id}"),
        "event_type": if result == "success" { "request.completed" } else { "request.failed" },
        "started_epoch_ms": now,
        "updated_epoch_ms": now,
        "finished_epoch_ms": now,
        "duration_ms": 0,
        "meta": {
            "request_id": request_id,
            "endpoint": endpoint,
            "response_status": if result == "success" { "completed" } else { "error" },
            "provider_status": status,
            "finish_reason": if result == "success" { "stop" } else { "error" }
        },
        "scope": { "port": port, "session": server_id },
        "result": result,
        "attempts": 1,
        "failed_attempts": if result == "success" { 0 } else { 1 },
        "switches": 0,
        "usage": null,
        "timing_internal_ms": null,
        "timing_external_ms": null,
        "servertool": false,
        "stopless": false,
        "raw_artifact_ref": null
    });
    let envelope = serde_json::json!({
        "schema_version": REQUEST_RECORD_SCHEMA_VERSION,
        "row": row
    });
    let mut line = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
    line.push(b'\n');
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    file.write_all(&line).map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

pub trait AsyncHttpHandler: Send + Sync + 'static {
    fn handle_async<'a>(
        &'a self,
        request: HttpRequest,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = HttpResponse> + Send + 'a>>;
}

/// Tokio listener owner. Each accepted connection is an independent task;
/// admission and response buffers stay bounded and client write failure
/// cancels the request-local provider operation.
pub struct AsyncHttpServer {
    listener: TokioTcpListener,
    max_request_bytes: usize,
    server_id: String,
    port: u16,
    request_ids: V4RequestIdCounter,
}

impl AsyncHttpServer {
    pub async fn bind(listen_address: &str) -> Result<Self, HttpServerError> {
        let listener = TokioTcpListener::bind(listen_address)
            .await
            .map_err(HttpServerError::Bind)?;
        let local = listener.local_addr().map_err(HttpServerError::Bind)?;
        Ok(Self {
            listener,
            max_request_bytes: MAX_BODY_BYTES,
            server_id: listen_address.to_string(),
            port: local.port(),
            request_ids: V4RequestIdCounter::new(),
        })
    }

    pub fn local_address(&self) -> Result<String, HttpServerError> {
        self.listener
            .local_addr()
            .map(|address| address.to_string())
            .map_err(HttpServerError::Bind)
    }

    pub async fn run_until<H: AsyncHttpHandler>(
        mut self,
        handler: std::sync::Arc<H>,
        stop: CancellationToken,
    ) -> Result<(), HttpServerError> {
        loop {
            let accepted = tokio::select! { _ = stop.cancelled() => return Ok(()), result = self.listener.accept() => result };
            let (stream, _) = accepted.map_err(HttpServerError::Accept)?;
            let local_day =
                local_day().map_err(|error| HttpServerError::RequestIdentity(error.to_string()))?;
            let request_identity = self
                .request_ids
                .next_request_identity(&self.server_id, &local_day)
                .map_err(|error| HttpServerError::RequestIdentity(error.to_string()))?;
            let handler = std::sync::Arc::clone(&handler);
            let connection_stop = stop.child_token();
            let max_request_bytes = self.max_request_bytes;
            let port = self.port;
            tokio::spawn(async move {
                let _ = serve_async_connection(
                    stream,
                    handler,
                    connection_stop,
                    max_request_bytes,
                    request_identity,
                    port,
                )
                .await;
            });
        }
    }

    pub async fn bind_persisted(listen_address: &str) -> Result<Self, HttpServerError> {
        let listener = TokioTcpListener::bind(listen_address)
            .await
            .map_err(HttpServerError::Bind)?;
        let local = listener.local_addr().map_err(HttpServerError::Bind)?;
        let request_ids = V4RequestIdCounter::from_default_state()
            .map_err(|error| HttpServerError::RequestIdentity(error.to_string()))?;
        Ok(Self {
            listener,
            max_request_bytes: MAX_BODY_BYTES,
            server_id: listen_address.to_string(),
            port: local.port(),
            request_ids,
        })
    }
}

async fn serve_async_connection<H: AsyncHttpHandler>(
    mut stream: TokioTcpStream,
    handler: std::sync::Arc<H>,
    server_stop: CancellationToken,
    max_request_bytes: usize,
    request_identity: RequestIdentity,
    port: u16,
) -> Result<(), std::io::Error> {
    let mut request_bytes = Vec::with_capacity(4096);
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let count = tokio::select! { _ = server_stop.cancelled() => return Ok(()), result = stream.read(&mut chunk) => result? };
        if count == 0 {
            return Ok(());
        }
        request_bytes.extend_from_slice(&chunk[..count]);
        if let Some(position) = request_bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
        {
            break position;
        }
        if request_bytes.len() > MAX_HEADER_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "HTTP headers too large",
            ));
        }
    };
    let head = std::str::from_utf8(&request_bytes[..header_end]).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "HTTP headers are not UTF-8",
        )
    })?;
    let mut lines = head.lines();
    let request_line = lines.next().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "HTTP request line missing")
    })?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "HTTP method missing"))?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "HTTP path missing"))?
        .to_string();
    let headers: Vec<(String, String)> = lines
        .map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, "HTTP header malformed")
                })
        })
        .collect::<Result<_, _>>()?;
    let content_length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, value)| {
            value.parse::<usize>().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "content-length invalid")
            })
        })
        .transpose()?
        .unwrap_or(0);
    if content_length > max_request_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "HTTP body too large",
        ));
    }
    let body_start = header_end + 4;
    while request_bytes.len() < body_start + content_length {
        let mut chunk = [0u8; 8192];
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Ok(());
        }
        request_bytes.extend_from_slice(&chunk[..count]);
    }
    let request = HttpRequest {
        method,
        path,
        headers,
        body: request_bytes[body_start..body_start + content_length].to_vec(),
        request_id: request_identity.request_id,
        server_id: request_identity.server_id,
        port,
    };
    let record_request_id = request.request_id.clone();
    let record_server_id = request.server_id.clone();
    let record_endpoint = request.path.clone();
    let record_port = request.port;
    let cancellation = server_stop.child_token();
    let response = handler.handle_async(request, cancellation.clone()).await;
    let streaming = response.stream.is_some();
    let head = if streaming {
        format!(
            "HTTP/1.1 {} OK\r\ncontent-type: {}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
            response.status, response.content_type
        )
    } else {
        format!(
            "HTTP/1.1 {} OK\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            response.status,
            response.content_type,
            response.body.len()
        )
    };
    if stream.write_all(head.as_bytes()).await.is_err() {
        cancellation.cancel();
        return Ok(());
    }
    if let Some(mut response_stream) = response.stream {
        loop {
            let result = tokio::task::spawn_blocking(move || {
                let mut response_stream = response_stream;
                let mut chunk = Vec::new();
                let result = response_stream.next_chunk(&mut chunk);
                (response_stream, result, chunk)
            })
            .await;
            let (next_stream, result, chunk) = match result {
                Ok(value) => value,
                Err(_) => {
                    cancellation.cancel();
                    return Ok(());
                }
            };
            response_stream = next_stream;
            let has_chunk = match result {
                Ok(value) => value,
                Err(_) => {
                    cancellation.cancel();
                    return Ok(());
                }
            };
            if !has_chunk {
                if stream.write_all(b"0\r\n\r\n").await.is_err() {
                    cancellation.cancel();
                }
                break;
            }
            if chunk.is_empty() {
                cancellation.cancel();
                break;
            }
            let prefix = format!("{:X}\r\n", chunk.len());
            if stream.write_all(prefix.as_bytes()).await.is_err()
                || stream.write_all(&chunk).await.is_err()
                || stream.write_all(b"\r\n").await.is_err()
            {
                cancellation.cancel();
                break;
            }
        }
    } else if stream.write_all(&response.body).await.is_err() {
        cancellation.cancel();
    }
    persist_request_record_fields(
        &record_request_id,
        &record_server_id,
        record_port,
        &record_endpoint,
        response.status,
    )
        .map_err(|error| std::io::Error::other(format!("request record persistence failed: {error}")))?;
    Ok(())
}

#[derive(Debug)]
pub enum HttpServerError {
    Bind(io::Error),
    Accept(io::Error),
    RequestIdentity(String),
}

impl std::fmt::Display for HttpServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bind(error) => write!(f, "HTTP listener bind failed: {error}"),
            Self::Accept(error) => write!(f, "HTTP accept failed: {error}"),
            Self::RequestIdentity(error) => write!(f, "HTTP request identity failed: {error}"),
        }
    }
}

impl std::error::Error for HttpServerError {}

pub struct V4HttpServer {
    listener: TcpListener,
    server_id: String,
    port: u16,
}

impl V4HttpServer {
    pub fn bind(listen_address: &str) -> Result<Self, HttpServerError> {
        let listener = TcpListener::bind(listen_address).map_err(HttpServerError::Bind)?;
        listener
            .set_nonblocking(true)
            .map_err(HttpServerError::Bind)?;
        let local = listener.local_addr().map_err(HttpServerError::Bind)?;
        Ok(Self {
            listener,
            server_id: listen_address.to_string(),
            port: local.port(),
        })
    }

    pub fn local_address(&self) -> Result<String, HttpServerError> {
        self.listener
            .local_addr()
            .map(|address| address.to_string())
            .map_err(HttpServerError::Bind)
    }

    pub fn run_until<H: HttpHandler>(
        self,
        handler: &mut H,
        mut should_stop: impl FnMut() -> bool,
    ) -> Result<(), HttpServerError> {
        self.run_until_with_counter(handler, V4RequestIdCounter::new(), || should_stop())
    }

    pub fn run_until_persisted<H: HttpHandler>(
        self,
        handler: &mut H,
        mut should_stop: impl FnMut() -> bool,
    ) -> Result<(), HttpServerError> {
        let request_ids = V4RequestIdCounter::from_default_state()
            .map_err(|error| HttpServerError::RequestIdentity(error.to_string()))?;
        self.run_until_with_counter(handler, request_ids, || should_stop())
    }

    fn run_until_with_counter<H: HttpHandler>(
        self,
        handler: &mut H,
        mut request_ids: V4RequestIdCounter,
        mut should_stop: impl FnMut() -> bool,
    ) -> Result<(), HttpServerError> {
        while !should_stop() {
            let stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => return Err(HttpServerError::Accept(error)),
            };
            // macOS may inherit O_NONBLOCK from the listener onto the accepted
            // socket. HTTP request reads are intentionally blocking within
            // this connection owner; otherwise an accept/read race resets a
            // valid client before its first bytes arrive.
            stream
                .set_nonblocking(false)
                .map_err(HttpServerError::Accept)?;
            stream
                .set_read_timeout(Some(Duration::from_secs(30)))
                .map_err(HttpServerError::Accept)?;
            stream
                .set_write_timeout(Some(Duration::from_secs(30)))
                .map_err(HttpServerError::Accept)?;
            let local_day =
                local_day().map_err(|error| HttpServerError::RequestIdentity(error.to_string()))?;
            let request_identity = request_ids
                .next_request_identity(&self.server_id, &local_day)
                .map_err(|error| HttpServerError::RequestIdentity(error.to_string()))?;
            if let Err(error) = serve_connection(stream, handler, request_identity, self.port) {
                if !matches!(error, ConnectionError::ClientDisconnected) {
                    eprintln!("v4 server connection failed: {error}");
                }
            }
        }
        Ok(())
    }
}

/// The server crate owns listener lifecycle, HTTP admission/framing, endpoint
/// dispatch entry, and client response emission. Application code only owns
/// the typed request-to-response business callback.
pub fn serve<H: HttpHandler>(listen_address: &str, handler: &mut H) -> Result<(), HttpServerError> {
    V4HttpServer::bind(listen_address)?.run_until(handler, || false)
}

#[derive(Debug)]
enum ConnectionError {
    ClientDisconnected,
    Io(io::Error),
    Request(String),
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClientDisconnected => f.write_str("client disconnected"),
            Self::Io(error) => write!(f, "I/O error: {error}"),
            Self::Request(error) => f.write_str(error),
        }
    }
}

fn serve_connection<H: HttpHandler>(
    mut stream: TcpStream,
    handler: &mut H,
    request_identity: RequestIdentity,
    port: u16,
) -> Result<(), ConnectionError> {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(ConnectionError::ClientDisconnected) => {
            return Err(ConnectionError::ClientDisconnected)
        }
        Err(ConnectionError::Request(error)) => {
            write_response(&mut stream, HttpResponse::error(400, error))?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let request = HttpRequest {
        request_id: request_identity.request_id,
        server_id: request_identity.server_id,
        port,
        ..request
    };
    let response = handler.handle(request.clone());
    let status = response.status;
    write_response(&mut stream, response)?;
    persist_request_record(&request, status).map_err(ConnectionError::Request)
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, ConnectionError> {
    let mut bytes = Vec::with_capacity(4096);
    let header_end = loop {
        let mut chunk = [0u8; 4096];
        let count = stream.read(&mut chunk).map_err(map_read_error)?;
        if count == 0 {
            return Err(ConnectionError::ClientDisconnected);
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(ConnectionError::Request(
                "HTTP headers too large".to_string(),
            ));
        }
    };
    let head = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        ConnectionError::Request(format!("HTTP headers are not UTF-8: {error}"))
    })?;
    let mut lines = head.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| ConnectionError::Request("HTTP request line missing".to_string()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| ConnectionError::Request("HTTP method missing".to_string()))?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| ConnectionError::Request("HTTP path missing".to_string()))?
        .to_string();
    if parts.next().is_none() {
        return Err(ConnectionError::Request("HTTP version missing".to_string()));
    }
    let headers: Vec<(String, String)> = lines
        .map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                .ok_or_else(|| ConnectionError::Request("HTTP header is malformed".to_string()))
        })
        .collect::<Result<_, _>>()?;
    if headers.iter().any(|(name, _)| name == "transfer-encoding") {
        return Err(ConnectionError::Request(
            "chunked transfer encoding is unsupported".to_string(),
        ));
    }
    let content_length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map(|(_, value)| {
            value
                .parse::<usize>()
                .map_err(|_| ConnectionError::Request("content-length is invalid".to_string()))
        })
        .transpose()?;
    let content_length = content_length.unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err(ConnectionError::Request("HTTP body too large".to_string()));
    }
    let body_start = header_end + 4;
    while bytes.len() < body_start + content_length {
        let mut chunk = [0u8; 8192];
        let count = stream.read(&mut chunk).map_err(map_read_error)?;
        if count == 0 {
            return Err(ConnectionError::ClientDisconnected);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(HttpRequest {
        method,
        path,
        headers,
        body: bytes[body_start..body_start + content_length].to_vec(),
        request_id: String::new(),
        server_id: String::new(),
        port: 0,
    })
}

fn local_day() -> Result<String, RequestIdentityError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            RequestIdentityError::Persistence(format!("request id clock moved backwards: {error}"))
        })?;
    let seconds = duration.as_secs() as libc::time_t;
    let tm = unsafe {
        let mut raw = std::mem::MaybeUninit::<libc::tm>::uninit();
        if libc::localtime_r(&seconds, raw.as_mut_ptr()).is_null() {
            return Err(RequestIdentityError::Persistence(
                "failed to format request id date".to_string(),
            ));
        }
        raw.assume_init()
    };
    Ok(format!(
        "{:04}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday
    ))
}

fn map_read_error(error: io::Error) -> ConnectionError {
    if matches!(
        error.kind(),
        io::ErrorKind::ConnectionReset | io::ErrorKind::UnexpectedEof
    ) {
        ConnectionError::ClientDisconnected
    } else {
        ConnectionError::Io(error)
    }
}

fn write_response(stream: &mut TcpStream, response: HttpResponse) -> Result<(), ConnectionError> {
    let reason = match response.status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let transfer = if response.stream.is_some() {
        "transfer-encoding: chunked\r\n"
    } else {
        ""
    };
    let length = if response.stream.is_some() {
        String::new()
    } else {
        format!("content-length: {}\r\n", response.body.len())
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\n{}{}connection: close\r\n\r\n",
        response.status, reason, response.content_type, length, transfer,
    );
    stream.write_all(head.as_bytes()).map_err(map_write_error)?;
    if let Some(mut response_stream) = response.stream {
        let mut chunk = Vec::with_capacity(8192);
        loop {
            chunk.clear();
            if !response_stream
                .next_chunk(&mut chunk)
                .map_err(map_write_error)?
            {
                break;
            }
            if chunk.is_empty() {
                return Err(ConnectionError::Io(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "response stream returned an empty chunk",
                )));
            }
            let size = format!("{:x}\r\n", chunk.len());
            stream.write_all(size.as_bytes()).map_err(map_write_error)?;
            stream.write_all(&chunk).map_err(map_write_error)?;
            stream.write_all(b"\r\n").map_err(map_write_error)?;
        }
        stream.write_all(b"0\r\n\r\n").map_err(map_write_error)
    } else {
        stream.write_all(&response.body).map_err(map_write_error)
    }
}

fn map_write_error(error: io::Error) -> ConnectionError {
    if matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
    ) {
        ConnectionError::ClientDisconnected
    } else {
        ConnectionError::Io(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleLine {
    pub server_id: String,
    pub request_id: String,
    pub entry_protocol: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct V4ConsoleTerminalOutput {
    lines: Vec<ConsoleLine>,
}

impl V4ConsoleTerminalOutput {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write(
        &mut self,
        server_id: &str,
        request_id: &str,
        entry_protocol: &str,
        severity: &str,
        message: &str,
    ) {
        self.lines.push(ConsoleLine {
            server_id: server_id.to_string(),
            request_id: request_id.to_string(),
            entry_protocol: entry_protocol.to_string(),
            severity: severity.to_string(),
            message: message.to_string(),
        });
    }

    pub fn lines(&self) -> impl Iterator<Item = &ConsoleLine> {
        self.lines.iter()
    }
}

/// Console projection facade (diagnostic-only).
#[derive(Debug, Clone, Default)]
pub struct ConsoleProjection {
    output: V4ConsoleTerminalOutput,
}

impl ConsoleProjection {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write(
        &mut self,
        server_id: &str,
        request_id: &str,
        entry_protocol: &str,
        severity: &str,
        message: &str,
    ) {
        self.output
            .write(server_id, request_id, entry_protocol, severity, message);
    }

    pub fn lines(&self) -> impl Iterator<Item = &ConsoleLine> {
        self.output.lines()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestIdentity {
    pub request_id: String,
    pub server_id: String,
    pub local_day: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestIdentityError {
    EmptyServerId,
    SequenceOverflow,
    Persistence(String),
}

impl std::fmt::Display for RequestIdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for RequestIdentityError {}

/// Deterministic server request identity counter.
#[derive(Debug, Clone, Default)]
pub struct V4RequestIdCounter {
    counters: BTreeMap<(String, String), u64>,
    state_file: Option<PathBuf>,
    loaded: bool,
    total_count: u64,
    window_count: u64,
    window_key: String,
}

impl V4RequestIdCounter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_default_state() -> Result<Self, RequestIdentityError> {
        let path = std::env::var_os("ROUTECODEX_REQUEST_ID_COUNTER_FILE")
            .or_else(|| std::env::var_os("RCC_REQUEST_ID_COUNTER_FILE"))
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|home| home.join(".rcc/state/request-id-counter.json"))
            })
            .ok_or_else(|| {
                RequestIdentityError::Persistence(
                    "HOME is required for request id state".to_string(),
                )
            })?;
        Self::from_state_file(path)
    }

    pub fn from_state_file(path: PathBuf) -> Result<Self, RequestIdentityError> {
        let mut counter = Self {
            state_file: Some(path),
            ..Self::default()
        };
        counter.load_state()?;
        Ok(counter)
    }

    pub fn next_request_identity(
        &mut self,
        server_id: &str,
        local_day: &str,
    ) -> Result<RequestIdentity, RequestIdentityError> {
        if server_id.is_empty() {
            return Err(RequestIdentityError::EmptyServerId);
        }
        if !self.loaded {
            self.load_state()?;
        }
        let key = (server_id.to_string(), local_day.to_string());
        if self.state_file.is_some() {
            if self.window_key != local_day {
                self.window_key = local_day.to_string();
                self.window_count = 0;
            }
            self.total_count = self
                .total_count
                .checked_add(1)
                .ok_or(RequestIdentityError::SequenceOverflow)?;
            self.window_count = self
                .window_count
                .checked_add(1)
                .ok_or(RequestIdentityError::SequenceOverflow)?;
        }
        let next = if self.state_file.is_some() {
            self.window_count
        } else {
            self.counters
                .get(&key)
                .copied()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or(RequestIdentityError::SequenceOverflow)?
        };
        if next == 0 {
            return Err(RequestIdentityError::SequenceOverflow);
        }
        self.counters.insert(key, next);
        self.persist_state()?;
        Ok(RequestIdentity {
            request_id: if self.state_file.is_some() {
                format!(
                    "{server_id}-{}-{}-{}",
                    request_id_timestamp()?,
                    self.total_count,
                    self.window_count
                )
            } else {
                format!("{server_id}-{}-{}-{}", request_id_timestamp()?, next, next)
            },
            server_id: server_id.to_string(),
            local_day: local_day.to_string(),
            sequence: next,
        })
    }

    fn load_state(&mut self) -> Result<(), RequestIdentityError> {
        self.loaded = true;
        let Some(path) = self.state_file.as_ref() else {
            return Ok(());
        };
        if !path.exists() {
            return Ok(());
        }
        let bytes = fs::read(path).map_err(|error| {
            RequestIdentityError::Persistence(format!("failed to read {}: {error}", path.display()))
        })?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
            RequestIdentityError::Persistence(format!(
                "failed to parse {}: {error}",
                path.display()
            ))
        })?;
        if value.get("version").and_then(serde_json::Value::as_u64)
            != Some(REQUEST_ID_STATE_VERSION)
        {
            return Err(RequestIdentityError::Persistence(format!(
                "unsupported request id counter version in {}",
                path.display()
            )));
        }
        self.total_count = value
            .get("totalCount")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                RequestIdentityError::Persistence(format!(
                    "missing totalCount in {}",
                    path.display()
                ))
            })?;
        self.window_count = value
            .get("windowCount")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                RequestIdentityError::Persistence(format!(
                    "missing windowCount in {}",
                    path.display()
                ))
            })?;
        self.window_key = value
            .get("windowKey")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                RequestIdentityError::Persistence(format!(
                    "missing windowKey in {}",
                    path.display()
                ))
            })?
            .to_string();
        Ok(())
    }

    fn persist_state(&self) -> Result<(), RequestIdentityError> {
        let Some(path) = self.state_file.as_ref() else {
            return Ok(());
        };
        let parent = path.parent().ok_or_else(|| {
            RequestIdentityError::Persistence("request id state has no parent".to_string())
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            RequestIdentityError::Persistence(format!(
                "failed to create {}: {error}",
                parent.display()
            ))
        })?;
        let body = serde_json::json!({
            "version": REQUEST_ID_STATE_VERSION,
            "totalCount": self.total_count,
            "windowCount": self.window_count,
            "windowKey": self.window_key,
            "updatedAt": utc_timestamp()?,
        });
        let tmp = path.with_extension(format!("json.tmp.{}", std::process::id()));
        fs::write(
            &tmp,
            serde_json::to_vec_pretty(&body)
                .map_err(|error| RequestIdentityError::Persistence(error.to_string()))?,
        )
        .map_err(|error| {
            RequestIdentityError::Persistence(format!("failed to write {}: {error}", tmp.display()))
        })?;
        fs::rename(&tmp, path).map_err(|error| {
            RequestIdentityError::Persistence(format!(
                "failed to publish {}: {error}",
                path.display()
            ))
        })
    }
}

fn request_id_timestamp() -> Result<String, RequestIdentityError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            RequestIdentityError::Persistence(format!("request id clock moved backwards: {error}"))
        })?;
    let millis = duration.as_millis();
    let seconds = (millis / 1000) as libc::time_t;
    let tm = unsafe {
        let mut raw = std::mem::MaybeUninit::<libc::tm>::uninit();
        if libc::localtime_r(&seconds, raw.as_mut_ptr()).is_null() {
            return Err(RequestIdentityError::Persistence(
                "failed to format request id timestamp".to_string(),
            ));
        }
        raw.assume_init()
    };
    Ok(format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}{:03}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        millis % 1000
    ))
}

fn utc_timestamp() -> Result<String, RequestIdentityError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            RequestIdentityError::Persistence(format!("request id clock moved backwards: {error}"))
        })?;
    let millis = duration.as_millis();
    let seconds = (millis / 1000) as libc::time_t;
    let tm = unsafe {
        let mut raw = std::mem::MaybeUninit::<libc::tm>::uninit();
        if libc::gmtime_r(&seconds, raw.as_mut_ptr()).is_null() {
            return Err(RequestIdentityError::Persistence(
                "failed to format request id UTC timestamp".to_string(),
            ));
        }
        raw.assume_init()
    };
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        millis % 1000
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireEvidenceRecord {
    pub entry_protocol: String,
    pub endpoint: String,
    pub port: u16,
    pub request_id: String,
    pub artifact_name: String,
    pub wire_bytes: Vec<u8>,
}

/// The two provider-side artifacts needed to attribute one request without
/// reconstructing it from a client payload. Both records carry the same
/// request identity and remain diagnostic-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderExchangeEvidence {
    pub provider_request: WireEvidenceRecord,
    pub provider_response: WireEvidenceRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireEvidenceError {
    EmptyRequestId,
}

impl std::fmt::Display for WireEvidenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for WireEvidenceError {}

/// Terminal-failure wire evidence store; flush is allowed only after the
/// server frame reaches EOF/error/drop.
#[derive(Debug, Clone, Default)]
pub struct V4ErrorEvidenceFlushOnTerminalFailure {
    records: Vec<WireEvidenceRecord>,
}

impl V4ErrorEvidenceFlushOnTerminalFailure {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn flush(
        &mut self,
        entry_protocol: &str,
        endpoint: &str,
        port: u16,
        request_id: &str,
        artifact_name: &str,
        wire_bytes: &[u8],
    ) -> Result<WireEvidenceRecord, WireEvidenceError> {
        if request_id.is_empty() {
            return Err(WireEvidenceError::EmptyRequestId);
        }
        let record = WireEvidenceRecord {
            entry_protocol: entry_protocol.to_string(),
            endpoint: endpoint.to_string(),
            port,
            request_id: request_id.to_string(),
            artifact_name: artifact_name.to_string(),
            wire_bytes: wire_bytes.to_vec(),
        };
        self.records.push(record.clone());
        Ok(record)
    }

    pub fn records(&self) -> impl Iterator<Item = &WireEvidenceRecord> {
        self.records.iter()
    }

    /// Capture the canonical B-side pair for one terminal failure. The
    /// method fixes artifact names at the owner boundary so callers cannot
    /// create an unrelated or cross-request evidence bundle.
    pub fn capture_provider_exchange(
        &mut self,
        entry_protocol: &str,
        endpoint: &str,
        port: u16,
        request_id: &str,
        provider_request: &[u8],
        provider_response: &[u8],
    ) -> Result<ProviderExchangeEvidence, WireEvidenceError> {
        let request = self.flush(
            entry_protocol,
            endpoint,
            port,
            request_id,
            "provider-request.json",
            provider_request,
        )?;
        let response = self.flush(
            entry_protocol,
            endpoint,
            port,
            request_id,
            "provider-response.json",
            provider_response,
        )?;
        Ok(ProviderExchangeEvidence {
            provider_request: request,
            provider_response: response,
        })
    }
}
