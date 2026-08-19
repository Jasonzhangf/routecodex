use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use routecodex_v4_base_node::Scope;
use routecodex_v4_error::ErrorChain;
use routecodex_v4_provider::{send_responses, send_responses_streaming, ProviderResponseStream};
use routecodex_v4_router::{select_target, ProviderCandidate};
use routecodex_v4_runtime::{
    build_responses_wire_request, parse_responses_provider_payload, project_runtime_fault,
    project_chat_request_to_responses, ResponsesProviderPayload, RuntimeFault, SkeletonRuntime,
};
use routecodex_v4_server::{serve, HttpHandler, HttpRequest, HttpResponse, ResponseStream};

const VERSION: &str = "0.1.0-v4-admission";
const DEFAULT_MANIFEST: &str = "generated/real-runtime-admission/manifest.compiled.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CompiledManifest {
    schema_version: u32,
    manifest_id: String,
    runtime_identity: String,
    manifest_digest: String,
    listen_address: String,
    candidates: Vec<ProviderCandidate>,
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn load_manifest(path: &Path) -> Result<CompiledManifest, String> {
    let bytes = fs::read(path).map_err(|error| format!("manifest read failed: {error}"))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("manifest JSON invalid: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "manifest must be an object".to_string())?;
    let expected = object
        .get("manifest_digest")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "manifest_digest missing".to_string())?;
    let mut unsigned = value.clone();
    unsigned
        .as_object_mut()
        .expect("object checked")
        .remove("manifest_digest");
    let canonical = serde_json::to_vec(&unsigned).map_err(|error| error.to_string())?;
    if sha256(&canonical) != expected {
        return Err(format!(
            "manifest digest drift: expected {expected}, actual {}",
            sha256(&canonical)
        ));
    }
    let manifest: CompiledManifest = serde_json::from_value(value)
        .map_err(|error| format!("manifest schema invalid: {error}"))?;
    if manifest.runtime_identity != "rccv4" {
        return Err("manifest runtime_identity must be rccv4".to_string());
    }
    Ok(manifest)
}

fn main() {
    if env::args().any(|arg| arg == "--version") {
        println!("rccv4 {VERSION}");
        return;
    }
    let manifest_path = env::var_os("RCCV4_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_MANIFEST));
    let manifest = match load_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(error) => {
            eprintln!("rccv4 startup failed: {error}");
            std::process::exit(78);
        }
    };
    eprintln!(
        "rccv4 identity={} manifest={}",
        manifest.runtime_identity, manifest.manifest_digest
    );
    let runtime = SkeletonRuntime::load(include_str!(
        "../../../contracts/skeleton-plan.contract.json"
    ))
    .unwrap_or_else(|error| {
        eprintln!("rccv4 startup failed: response plugin plan invalid: {error}");
        std::process::exit(78);
    });
    let mut handler = AdmissionHandler {
        manifest: &manifest,
        runtime: Arc::new(Mutex::new(runtime)),
    };
    if let Err(error) = serve(&manifest.listen_address, &mut handler) {
        eprintln!("rccv4 listener failed: {error}");
        std::process::exit(98);
    }
}

struct AdmissionHandler<'a> {
    manifest: &'a CompiledManifest,
    runtime: Arc<Mutex<SkeletonRuntime>>,
}

impl HttpHandler for AdmissionHandler<'_> {
    fn handle(&mut self, request: HttpRequest) -> HttpResponse {
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/health") => json_response(
                200,
                serde_json::json!({
                    "id": "rccv4", "version": VERSION, "manifest_digest": self.manifest.manifest_digest
                }),
            ),
            ("GET", "/v1/models") => json_response(
                200,
                serde_json::json!({
                    "object": "list", "data": self.manifest.candidates.iter().map(|candidate| serde_json::json!({
                        "id": candidate.model, "object": "model", "owned_by": candidate.provider_id
                    })).collect::<Vec<_>>()
                }),
            ),
            ("POST", "/v1/responses") => {
                match handle_responses(self.manifest, &self.runtime, &request, "responses", "direct") {
                    Ok(response) => response,
                    Err(response) => response,
                }
            }
            ("POST", "/v1/chat/completions") => {
                match handle_responses(self.manifest, &self.runtime, &request, "chat", "relay") {
                    Ok(response) => response,
                    Err(response) => response,
                }
            }
            _ => project_fault(
                &request,
                RuntimeFault::new("route_not_found", "route not found"),
                404,
            ),
        }
    }
}

fn handle_responses(
    manifest: &CompiledManifest,
    runtime: &Arc<Mutex<SkeletonRuntime>>,
    request: &HttpRequest,
    entry_protocol: &str,
    continuation_owner: &str,
) -> Result<HttpResponse, HttpResponse> {
    let body: serde_json::Value = serde_json::from_slice(&request.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("invalid_request", format!("invalid JSON: {error}")),
            400,
        )
    })?;
    let model = body
        .get("model")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            project_fault(
                request,
                RuntimeFault::new("invalid_request", "model is required"),
                400,
            )
        })?;
    let stream_mode = body
        .get("stream")
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                project_fault(
                    request,
                    RuntimeFault::new("invalid_request", "stream must be a boolean"),
                    400,
                )
            })
        })
        .transpose()?
        .unwrap_or(false);
    let session_scope = request
        .header("x-rccv4-session-id")
        .unwrap_or(&request.request_id);
    let conversation_scope = request
        .header("x-rccv4-conversation-id")
        .unwrap_or(session_scope);
    runtime
        .lock()
        .map_err(|_| {
            project_fault(
                request,
                RuntimeFault::new("request_runtime_lock", "request runtime lock poisoned"),
                500,
            )
        })?
        .execute_request_scoped(
            &format!("{entry_protocol}:request"),
            &format!("{}:request", request.request_id),
            request.port,
            session_scope,
            conversation_scope,
        )
        .map_err(|fault| project_fault(request, fault, 409))?;
    let target = select_target(&manifest.candidates, model).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("model_unavailable", error.to_string()),
            404,
        )
    })?;
    let provider_body = client_to_responses_request(&body, entry_protocol)
        .map_err(|fault| project_fault(request, fault, 400))?;
    let wire = build_responses_wire_request(&provider_body, &target.model, stream_mode)
        .map_err(|fault| project_fault(request, fault, 400))?;
    let wire_body: serde_json::Value = serde_json::from_slice(&wire.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("provider_wire_encode", error.to_string()),
            500,
        )
    })?;
    if stream_mode {
        let stream = send_responses_streaming(&target.config_path, &target.model, &wire_body)
            .map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new(error.code.as_str(), error.message)
                        .with_status(error.status.unwrap_or(502)),
                    error.status.unwrap_or(502),
                )
            })?;
        let status = stream.status();
        if status >= 400 {
            let fault = RuntimeFault::new(
                "provider_http_error",
                format!("upstream Responses returned HTTP {status}"),
            )
            .with_status(status);
            return Err(project_fault(request, fault, status));
        }
        let content_type = stream.content_type().to_string();
        if !content_type
            .to_ascii_lowercase()
            .contains("text/event-stream")
        {
            return Err(project_fault(
                request,
                RuntimeFault::new(
                    "provider_sse_content_type",
                    format!("streaming Responses returned unsupported content type {content_type}"),
                ),
                502,
            ));
        }
        return Ok(HttpResponse::streaming(
            status,
            "text/event-stream",
            Box::new(ResponsesSseStream::new(
                stream,
                Arc::clone(runtime),
                request.request_id.clone(),
                request.port,
                entry_protocol.to_string(),
                continuation_owner.to_string(),
                session_scope.to_string(),
                conversation_scope.to_string(),
            )),
        ));
    }
    let raw =
        send_responses(&target.config_path, &target.model, &wire_body, false).map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new(error.code.as_str(), error.message),
                error.status.unwrap_or(502),
            )
        })?;
    match parse_responses_provider_payload(raw.status, &raw.content_type, &raw.body, stream_mode)
        .map_err(|fault| project_fault(request, fault, 502))?
    {
        ResponsesProviderPayload::Json(value) => {
            let provider_raw = serde_json::to_string(&value).map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new("provider_json_encode", error.to_string()),
                    502,
                )
            })?;
            let report = runtime
                .lock()
                .map_err(|_| {
                    project_fault(
                        request,
                        RuntimeFault::new(
                            "response_runtime_lock",
                            "response runtime lock poisoned",
                        ),
                        500,
                    )
                })?
                .execute_provider_response_scoped(
                    &provider_raw,
                    &request.request_id,
                    request.port,
                    session_scope,
                    conversation_scope,
                    entry_protocol,
                    continuation_owner,
                )
                .map_err(|fault| project_fault(request, fault, 502))?;
            let frame = report.client_frame.ok_or_else(|| {
                project_fault(
                    request,
                    RuntimeFault::new(
                        "response_frame_missing",
                        "response chain produced no client frame",
                    ),
                    502,
                )
            })?;
            let projected = serde_json::from_str(&frame).map_err(|error| {
                project_fault(
                    request,
                    RuntimeFault::new("response_frame_invalid", error.to_string()),
                    502,
                )
            })?;
            Ok(json_response(raw.status, projected))
        }
        ResponsesProviderPayload::Sse(_) => Err(project_fault(
            request,
            RuntimeFault::new(
                "provider_sse_unexpected",
                "non-stream Responses transport returned SSE payload",
            ),
            502,
        )),
    }
}

fn client_to_responses_request(
    body: &serde_json::Value,
    entry_protocol: &str,
) -> Result<serde_json::Value, RuntimeFault> {
    if entry_protocol == "responses" {
        return Ok(body.clone());
    }
    if entry_protocol == "chat" {
        return project_chat_request_to_responses(body);
    }
    Err(RuntimeFault::new(
        "client_protocol_unsupported",
        format!("unsupported client request protocol {entry_protocol}"),
    ))
}

trait ProviderSseSource: Send {
    fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String>;
    fn wait(&mut self) -> Result<(), String>;
}

impl ProviderSseSource for ProviderResponseStream {
    fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String> {
        ProviderResponseStream::read_chunk(self, chunk).map_err(|error| error.to_string())
    }

    fn wait(&mut self) -> Result<(), String> {
        ProviderResponseStream::wait(self).map_err(|error| error.to_string())
    }
}

struct ResponsesSseStream<S = ProviderResponseStream> {
    stream: S,
    runtime: Arc<Mutex<SkeletonRuntime>>,
    request_id: String,
    port: u16,
    entry_protocol: String,
    continuation_owner: String,
    session_scope: String,
    conversation_scope: String,
    frame_sequence: u64,
    pending: Vec<u8>,
    frame_buffer: Vec<u8>,
    terminal_seen: bool,
    close_after_pending: bool,
}

impl<S: ProviderSseSource> ResponsesSseStream<S> {
    fn new(
        stream: S,
        runtime: Arc<Mutex<SkeletonRuntime>>,
        request_id: String,
        port: u16,
        entry_protocol: String,
        continuation_owner: String,
        session_scope: String,
        conversation_scope: String,
    ) -> Self {
        Self {
            stream,
            runtime,
            request_id,
            port,
            entry_protocol,
            continuation_owner,
            session_scope,
            conversation_scope,
            frame_sequence: 0,
            pending: Vec::new(),
            frame_buffer: Vec::new(),
            terminal_seen: false,
            close_after_pending: false,
        }
    }

    fn queue_error(&mut self, message: impl Into<String>) {
        let message = message.into();
        let payload = serde_json::json!({
            "type": "error",
            "error": {"message": message}
        });
        self.pending.extend_from_slice(b"event: error\n");
        self.pending.extend_from_slice(b"data: ");
        self.pending.extend_from_slice(
            &serde_json::to_vec(&payload).expect("stream error projection is serializable"),
        );
        self.pending.extend_from_slice(b"\n\n");
        self.close_after_pending = true;
    }

    fn project_frame(&mut self, frame: &[u8], terminal: bool) -> Result<(), RuntimeFault> {
        let event = sse_event(frame)?;
        self.frame_sequence += 1;
        let frame_request_id = format!("{}:sse:{}", self.request_id, self.frame_sequence);
        let owner = if terminal {
            self.continuation_owner.as_str()
        } else {
            "none"
        };
        let report = self
            .runtime
            .lock()
            .map_err(|_| {
                RuntimeFault::new("response_runtime_lock", "response runtime lock poisoned")
            })?
            .execute_provider_response_scoped(
                std::str::from_utf8(frame).map_err(|error| {
                    RuntimeFault::new("provider_sse_utf8", error.to_string())
                })?,
                &frame_request_id,
                self.port,
                &self.session_scope,
                &self.conversation_scope,
                &self.entry_protocol,
                owner,
            )?;
        let client_frame = report.client_frame.ok_or_else(|| {
            RuntimeFault::new(
                "response_frame_missing",
                "response chain produced no client frame",
            )
        })?;
        if self.entry_protocol == "responses" {
            if let Some(event) = event {
                self.pending.extend_from_slice(b"event: ");
                self.pending.extend_from_slice(event.as_bytes());
                self.pending.push(b'\n');
            }
        }
        self.pending.extend_from_slice(b"data: ");
        self.pending.extend_from_slice(client_frame.as_bytes());
        self.pending.extend_from_slice(b"\n\n");
        if terminal && self.entry_protocol == "chat" {
            self.pending.extend_from_slice(b"data: [DONE]\n\n");
        }
        Ok(())
    }
}

impl<S: ProviderSseSource> ResponseStream for ResponsesSseStream<S> {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        loop {
            if !self.pending.is_empty() {
                chunk.extend_from_slice(&self.pending);
                self.pending.clear();
                return Ok(true);
            }
            if self.close_after_pending {
                return Ok(false);
            }
            let mut bytes = [0u8; 8192];
            let count = match self.stream.read_chunk(&mut bytes) {
                Ok(count) => count,
                Err(error) => {
                    self.queue_error(format!("provider SSE read failed: {error}"));
                    continue;
                }
            };
            if count == 0 {
                if !self.terminal_seen {
                    self.queue_error(
                        "provider SSE ended before response.completed or response.failed",
                    );
                    continue;
                }
                if let Err(error) = self.stream.wait() {
                    self.queue_error(format!("provider SSE closeout failed: {error}"));
                    continue;
                }
                return Ok(false);
            }
            self.frame_buffer.extend_from_slice(&bytes[..count]);
            while let Some(end) = find_frame_end(&self.frame_buffer) {
                let frame = self.frame_buffer[..end].to_vec();
                self.frame_buffer.drain(..end);
                let terminal = match routecodex_v4_runtime::validate_responses_sse_frame(&frame) {
                    Ok(terminal) => terminal,
                    Err(fault) => {
                        self.queue_error(fault.to_string());
                        break;
                    }
                };
                self.terminal_seen |= terminal;
                if let Err(fault) = self.project_frame(&frame, terminal) {
                    self.queue_error(fault.to_string());
                    break;
                }
            }
        }
    }
}

fn sse_event(frame: &[u8]) -> Result<Option<&str>, RuntimeFault> {
    let text = std::str::from_utf8(frame)
        .map_err(|error| RuntimeFault::new("provider_sse_utf8", error.to_string()))?;
    Ok(text
        .lines()
        .find_map(|line| line.strip_prefix("event:"))
        .map(str::trim_start)
        .filter(|event| !event.is_empty()))
}

fn find_frame_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| position + 2)
}

fn project_fault(request: &HttpRequest, fault: RuntimeFault, status: u16) -> HttpResponse {
    let scope = Scope::new(&request.request_id, "v4-admission", request.port, "", "");
    let mut chain = ErrorChain::new(scope);
    match project_runtime_fault(&mut chain, fault.clone()) {
        Ok(projection) => HttpResponse::error(status, projection.message),
        Err(error) => HttpResponse::error(
            500,
            format!(
                "error chain projection failed for {}: {error:?}",
                fault.code
            ),
        ),
    }
}

fn json_response(status: u16, value: serde_json::Value) -> HttpResponse {
    let body = serde_json::to_vec(&value).expect("JSON response value is serializable");
    HttpResponse::json(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct MockSseSource {
        chunks: VecDeque<Result<Vec<u8>, String>>,
        wait_result: Result<(), String>,
    }

    impl ProviderSseSource for MockSseSource {
        fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String> {
            match self.chunks.pop_front() {
                Some(Ok(bytes)) => {
                    let count = bytes.len();
                    chunk[..count].copy_from_slice(&bytes);
                    Ok(count)
                }
                Some(Err(error)) => Err(error),
                None => Ok(0),
            }
        }

        fn wait(&mut self) -> Result<(), String> {
            self.wait_result.clone()
        }
    }

    fn runtime() -> Arc<Mutex<SkeletonRuntime>> {
        Arc::new(Mutex::new(
            SkeletonRuntime::load(include_str!(
                "../../../contracts/skeleton-plan.contract.json"
            ))
            .expect("response plan must load"),
        ))
    }

    fn stream(chunks: Vec<Result<Vec<u8>, String>>) -> ResponsesSseStream<MockSseSource> {
        stream_for(chunks, "responses", "direct")
    }

    fn stream_for(
        chunks: Vec<Result<Vec<u8>, String>>,
        entry_protocol: &str,
        continuation_owner: &str,
    ) -> ResponsesSseStream<MockSseSource> {
        ResponsesSseStream::new(
            MockSseSource {
                chunks: chunks.into(),
                wait_result: Ok(()),
            },
            runtime(),
            "request-1".to_string(),
            17777,
            entry_protocol.to_string(),
            continuation_owner.to_string(),
            "session-1".to_string(),
            "conversation-1".to_string(),
        )
    }

    #[test]
    fn terminal_frame_runs_response_chain_and_is_rebuilt() {
        let frame = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"abc\"}}\n\n";
        let mut stream = stream(vec![Ok(frame.to_vec())]);
        let mut chunk = Vec::new();
        assert!(stream.next_chunk(&mut chunk).expect("frame must project"));
        assert_ne!(chunk, frame, "client frame must be rebuilt, not piped");
        assert_eq!(sse_event(&chunk).expect("event must parse"), Some("response.completed"));
        let projected: serde_json::Value = serde_json::from_str(
            chunk
                .split(|byte| *byte == b'\n')
                .find_map(|line| line.strip_prefix(b"data: "))
                .and_then(|line| std::str::from_utf8(line).ok())
                .expect("projected data line must exist"),
        )
        .expect("projected data must be JSON");
        assert_eq!(projected, serde_json::json!({
            "type": "response.completed", "response": {"id": "abc"}
        }));
        chunk.clear();
        assert!(!stream.next_chunk(&mut chunk).expect("stream must close"));
    }

    #[test]
    fn premature_eof_emits_explicit_error_event_before_close() {
        let mut stream = stream(Vec::new());
        let mut chunk = Vec::new();
        assert!(stream.next_chunk(&mut chunk).expect("error event must emit"));
        let text = String::from_utf8(chunk).expect("error event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("ended before response.completed or response.failed"));
        let mut closed = Vec::new();
        assert!(!stream.next_chunk(&mut closed).expect("stream must close"));
    }

    #[test]
    fn malformed_frame_emits_explicit_error_event() {
        let mut stream = stream(vec![Ok(b"event: response.output_text.delta\ndata: {bad}\n\n".to_vec())]);
        let mut chunk = Vec::new();
        assert!(stream.next_chunk(&mut chunk).expect("error event must emit"));
        let text = String::from_utf8(chunk).expect("error event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("provider_sse_malformed"));
    }

    #[test]
    fn provider_read_failure_emits_explicit_error_event() {
        let mut stream = stream(vec![Err("read exploded".to_string())]);
        let mut chunk = Vec::new();
        assert!(stream.next_chunk(&mut chunk).expect("error event must emit"));
        let text = String::from_utf8(chunk).expect("error event must be UTF-8");
        assert!(text.starts_with("event: error\ndata: "));
        assert!(text.contains("provider SSE read failed: read exploded"));
    }

    #[test]
    fn chat_request_projects_to_responses_input_without_control_reconstruction() {
        let body = serde_json::json!({
            "model": "m",
            "messages": [{"role": "user", "content": "hello"}],
            "debug": {"business": true},
            "tools": [{"type": "function", "function": {
                "name": "lookup", "description": "lookup", "parameters": {"type": "object"}
            }}]
        });
        let projected = client_to_responses_request(&body, "chat")
            .expect("chat request must project to Responses input");
        assert_eq!(projected["input"], body["messages"]);
        assert_eq!(projected["tools"][0]["name"], "lookup");
        assert_eq!(projected["debug"], body["debug"]);
    }

    #[test]
    fn relay_terminal_frame_projects_chat_chunk_and_done() {
        let frame = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"m\"}}\n\n";
        let mut stream = stream_for(vec![Ok(frame.to_vec())], "chat", "relay");
        let mut chunk = Vec::new();
        assert!(stream.next_chunk(&mut chunk).expect("relay frame must project"));
        let text = String::from_utf8(chunk).expect("relay frame must be UTF-8");
        assert!(!text.contains("event: response.completed"));
        assert!(text.contains("\"object\":\"chat.completion.chunk\""));
        assert!(text.ends_with("data: [DONE]\n\n"));
    }
}
