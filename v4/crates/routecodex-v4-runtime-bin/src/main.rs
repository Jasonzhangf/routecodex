use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use routecodex_v4_provider::{
    send_responses, send_responses_streaming, ProviderResponseStream,
};
use routecodex_v4_router::{select_target, ProviderCandidate};
use routecodex_v4_runtime::{
    build_responses_wire_request, parse_responses_provider_payload, project_runtime_fault,
    ResponsesProviderPayload, RuntimeFault,
};
use routecodex_v4_server::{serve, HttpHandler, HttpRequest, HttpResponse, ResponseStream};
use routecodex_v4_base_node::Scope;
use routecodex_v4_error::ErrorChain;

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
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| format!("manifest JSON invalid: {error}"))?;
    let object = value.as_object().ok_or_else(|| "manifest must be an object".to_string())?;
    let expected = object.get("manifest_digest").and_then(|value| value.as_str()).ok_or_else(|| "manifest_digest missing".to_string())?;
    let mut unsigned = value.clone();
    unsigned.as_object_mut().expect("object checked").remove("manifest_digest");
    let canonical = serde_json::to_vec(&unsigned).map_err(|error| error.to_string())?;
    if sha256(&canonical) != expected {
        return Err(format!("manifest digest drift: expected {expected}, actual {}", sha256(&canonical)));
    }
    let manifest: CompiledManifest = serde_json::from_value(value).map_err(|error| format!("manifest schema invalid: {error}"))?;
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
    let manifest_path = env::var_os("RCCV4_MANIFEST").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(DEFAULT_MANIFEST));
    let manifest = match load_manifest(&manifest_path) {
        Ok(manifest) => manifest,
        Err(error) => {
            eprintln!("rccv4 startup failed: {error}");
            std::process::exit(78);
        }
    };
    eprintln!("rccv4 identity={} manifest={}", manifest.runtime_identity, manifest.manifest_digest);
    let mut handler = AdmissionHandler { manifest: &manifest };
    if let Err(error) = serve(&manifest.listen_address, &mut handler) {
        eprintln!("rccv4 listener failed: {error}");
        std::process::exit(98);
    }
}

struct AdmissionHandler<'a> {
    manifest: &'a CompiledManifest,
}

impl HttpHandler for AdmissionHandler<'_> {
    fn handle(&mut self, request: HttpRequest) -> HttpResponse {
        match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => json_response(200, serde_json::json!({
            "id": "rccv4", "version": VERSION, "manifest_digest": self.manifest.manifest_digest
        })),
        ("GET", "/v1/models") => json_response(200, serde_json::json!({
            "object": "list", "data": self.manifest.candidates.iter().map(|candidate| serde_json::json!({
                "id": candidate.model, "object": "model", "owned_by": candidate.provider_id
            })).collect::<Vec<_>>()
        })),
        ("POST", "/v1/responses") => match handle_responses(self.manifest, &request) {
            Ok(response) => response,
            Err(response) => response,
        },
        _ => project_fault(
            &request,
            RuntimeFault::new("route_not_found", "route not found"),
            404,
        ),
        }
    }
}

fn handle_responses(manifest: &CompiledManifest, request: &HttpRequest) -> Result<HttpResponse, HttpResponse> {
    let body: serde_json::Value = serde_json::from_slice(&request.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("invalid_request", format!("invalid JSON: {error}")),
            400,
        )
    })?;
    let model = body.get("model").and_then(|value| value.as_str()).ok_or_else(|| {
        project_fault(
            request,
            RuntimeFault::new("invalid_request", "model is required"),
            400,
        )
    })?;
    let stream_mode = body.get("stream").map(|value| value.as_bool().ok_or_else(|| {
        project_fault(
            request,
            RuntimeFault::new("invalid_request", "stream must be a boolean"),
            400,
        )
    })).transpose()?.unwrap_or(false);
    let target = select_target(&manifest.candidates, model).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("model_unavailable", error.to_string()),
            404,
        )
    })?;
    let wire = build_responses_wire_request(&body, &target.model, stream_mode).map_err(|fault| {
        project_fault(request, fault, 400)
    })?;
    let wire_body: serde_json::Value = serde_json::from_slice(&wire.body).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new("provider_wire_encode", error.to_string()),
            500,
        )
    })?;
    if stream_mode {
        let stream = send_responses_streaming(&target.config_path, &target.model, &wire_body).map_err(|error| {
            project_fault(
                request,
                RuntimeFault::new(error.code.as_str(), error.message).with_status(error.status.unwrap_or(502)),
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
        if !content_type.to_ascii_lowercase().contains("text/event-stream") {
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
            Box::new(ResponsesSseStream::new(stream)),
        ));
    }
    let raw = send_responses(&target.config_path, &target.model, &wire_body, false).map_err(|error| {
        project_fault(
            request,
            RuntimeFault::new(error.code.as_str(), error.message),
            error.status.unwrap_or(502),
        )
    })?;
    match parse_responses_provider_payload(raw.status, &raw.content_type, &raw.body, stream_mode).map_err(|fault| {
        project_fault(request, fault, 502)
    })? {
        ResponsesProviderPayload::Json(value) => Ok(json_response(raw.status, value)),
        ResponsesProviderPayload::Sse(bytes) => Ok(HttpResponse::new(raw.status, "text/event-stream", bytes)),
    }
}

struct ResponsesSseStream {
    stream: ProviderResponseStream,
    pending: Vec<u8>,
    frame_buffer: Vec<u8>,
    terminal_seen: bool,
}

impl ResponsesSseStream {
    fn new(stream: ProviderResponseStream) -> Self {
        Self {
            stream,
            pending: Vec::new(),
            frame_buffer: Vec::new(),
            terminal_seen: false,
        }
    }
}

impl ResponseStream for ResponsesSseStream {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        loop {
            if !self.pending.is_empty() {
                chunk.extend_from_slice(&self.pending);
                self.pending.clear();
                return Ok(true);
            }
            let mut bytes = [0u8; 8192];
            let count = self.stream.read_chunk(&mut bytes).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::Other, error.to_string())
            })?;
            if count == 0 {
                if !self.terminal_seen {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "provider SSE ended before response.completed or response.failed",
                    ));
                }
                self.stream
                    .wait()
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;
                return Ok(false);
            }
            self.frame_buffer.extend_from_slice(&bytes[..count]);
            while let Some(end) = find_frame_end(&self.frame_buffer) {
                let frame = self.frame_buffer[..end].to_vec();
                self.frame_buffer.drain(..end);
                let terminal = routecodex_v4_runtime::validate_responses_sse_frame(&frame)
                    .map_err(|fault| std::io::Error::new(std::io::ErrorKind::InvalidData, fault.to_string()))?;
                self.terminal_seen |= terminal;
                self.pending.extend_from_slice(&frame);
            }
        }
    }
}

fn find_frame_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|window| window == b"\n\n").map(|position| position + 2)
}

fn project_fault(request: &HttpRequest, fault: RuntimeFault, status: u16) -> HttpResponse {
    let scope = Scope::new(&request.request_id, "v4-admission", request.port, "", "");
    let mut chain = ErrorChain::new(scope);
    match project_runtime_fault(&mut chain, fault.clone()) {
        Ok(projection) => HttpResponse::error(status, projection.message),
        Err(error) => HttpResponse::error(
            500,
            format!("error chain projection failed for {}: {error:?}", fault.code),
        ),
    }
}

fn json_response(status: u16, value: serde_json::Value) -> HttpResponse {
    let body = serde_json::to_vec(&value).expect("JSON response value is serializable");
    HttpResponse::json(status, body)
}
