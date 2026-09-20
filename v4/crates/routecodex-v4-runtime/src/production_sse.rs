//! Production SSE transport driver.
//!
//! This module owns byte framing, full-attempt buffering, client queueing and
//! lifecycle handoff. Provider semantics and client projection are separate
//! owners: the provider attempt is materialized before any client frame is
//! enqueued.

use crate::{
    production_pipeline::emit_payload_console_events, ResponseStreamDisposition,
    ResponseStreamProcessor, RuntimeFault, SkeletonRuntime, V4RuntimeTimingSummary,
};
use routecodex_v4_provider::{NativeProviderResponseStream, ProviderResponseStream};
use routecodex_v4_server::{HttpRequest, ResponseStream};
use routecodex_v4_standard_plugins::protocol::provider_response::{
    classify_provider_sse_terminal, ProviderSseTerminalDisposition,
};
use routecodex_v4_standard_plugins::sse_transport::{
    production_transport_pair, SseEgressPlugin, SseIngressPlugin, SseTransportError,
    SseTransportFrame,
};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

const MAX_PROVIDER_ATTEMPT_BYTES: usize = 16 * 1024 * 1024;

pub trait ProviderSseSource: Send {
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

pub struct NativeProviderSseSource {
    stream: NativeProviderResponseStream,
    cancellation: CancellationToken,
    runtime: tokio::runtime::Handle,
    pending: Vec<u8>,
}

pub struct BufferedProviderSseSource {
    bytes: Vec<u8>,
    offset: usize,
}

impl BufferedProviderSseSource {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes, offset: 0 }
    }
}

impl NativeProviderSseSource {
    pub fn new(
        stream: NativeProviderResponseStream,
        cancellation: CancellationToken,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        Self {
            stream,
            cancellation,
            runtime,
            pending: Vec::new(),
        }
    }

    pub fn status(&self) -> u16 {
        self.stream.status()
    }

    pub fn content_type(&self) -> &str {
        self.stream.content_type()
    }

    pub fn read_error_body(&mut self) -> Result<Vec<u8>, String> {
        self.runtime
            .block_on(self.stream.read_error_body())
            .map_err(|error| error.to_string())
    }

    /// Materialize one provider attempt up to its protocol terminal so the
    /// product error policy can inspect complete bytes before any client
    /// egress. Sealing at the terminal (not TCP EOF) preserves the declared
    /// full-attempt boundary without waiting for transport close.
    pub fn read_attempt_until_terminal(
        &mut self,
        protocol: &str,
    ) -> Result<(Vec<u8>, ProviderSseTerminalDisposition), String> {
        let protocol = match protocol {
            "openai_chat" | "openai-chat" | "openai" => "chat",
            "openai-responses" | "openai_responses" => "responses",
            other => other,
        };
        let (mut ingress, _) = production_transport_pair(std::time::Instant::now())
            .map_err(|error| format!("{error:?}"))?;
        let mut attempt = Vec::new();
        loop {
            let bytes = self
                .runtime
                .block_on(self.stream.next_chunk())
                .map_err(|error| error.to_string())?;
            let Some(bytes) = bytes else {
                return Ok((
                    attempt,
                    ProviderSseTerminalDisposition::Failed {
                        message: "provider SSE ended without a protocol terminal".to_string(),
                    },
                ));
            };
            extend_bounded_attempt(&mut attempt, &bytes)?;
            attempt.extend_from_slice(&bytes);
            let frames = ingress
                .push_chunk(&bytes, std::time::Instant::now())
                .map_err(|error| format!("{error:?}"))?;
            for (index, frame) in frames.iter().enumerate() {
                let disposition = classify_provider_sse_terminal(protocol, frame.as_bytes())?;
                if !matches!(disposition, ProviderSseTerminalDisposition::Continue) {
                    if frames_after_terminal(&mut ingress, &frames, index)? {
                        return Err(
                            "provider emitted a frame after its protocol terminal".to_string()
                        );
                    }
                    return Ok((attempt, disposition));
                }
            }
        }
    }
}

fn frames_after_terminal(
    ingress: &mut SseIngressPlugin,
    frames: &[SseTransportFrame],
    terminal_index: usize,
) -> Result<bool, String> {
    if terminal_index + 1 < frames.len() {
        return Ok(true);
    }
    let terminal = frames
        .get(terminal_index)
        .ok_or_else(|| "provider terminal frame is not in the framed attempt".to_string())?;
    let terminal_end = terminal
        .as_bytes()
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|position| position + 2)
        .or_else(|| {
            terminal
                .as_bytes()
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4)
        })
        .ok_or_else(|| "provider terminal frame has no complete frame boundary".to_string())?;
    let trailing = ingress
        .push_chunk(&terminal.as_bytes()[terminal_end..], std::time::Instant::now())
        .map_err(|error| format!("{error:?}"))?;
    Ok(!trailing.is_empty() || ingress.finish().is_err())
}

fn extend_bounded_attempt(attempt: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
    if attempt.len().saturating_add(bytes.len()) > MAX_PROVIDER_ATTEMPT_BYTES {
        Err("provider SSE attempt exceeded bounded staging".to_string())
    } else {
        Ok(())
    }
}

/// True when a complete provider SSE frame carries the protocol terminal
/// event. Provider semantics come from the protocol owner's typed classifier;
/// the runtime only asks whether the attempt may be sealed before transport
/// close.
impl ProviderSseSource for NativeProviderSseSource {
    fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String> {
        if !self.pending.is_empty() {
            let count = self.pending.len().min(chunk.len());
            chunk[..count].copy_from_slice(&self.pending[..count]);
            self.pending.drain(..count);
            return Ok(count);
        }
        let bytes = self
            .runtime
            .block_on(self.stream.next_chunk())
            .map_err(|error| error.to_string())?;
        let Some(bytes) = bytes else {
            return Ok(0);
        };
        let count = bytes.len().min(chunk.len());
        chunk[..count].copy_from_slice(&bytes[..count]);
        if count < bytes.len() {
            self.pending.extend_from_slice(&bytes[count..]);
        }
        Ok(count)
    }

    fn wait(&mut self) -> Result<(), String> {
        if self.cancellation.is_cancelled() {
            return Err("provider stream cancelled".to_string());
        }
        Ok(())
    }
}

impl ProviderSseSource for BufferedProviderSseSource {
    fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String> {
        let available = self.bytes.len() - self.offset;
        let count = available.min(chunk.len());
        chunk[..count].copy_from_slice(&self.bytes[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }

    fn wait(&mut self) -> Result<(), String> {
        Ok(())
    }
}

impl ProviderSseSource for Box<dyn ProviderSseSource> {
    fn read_chunk(&mut self, chunk: &mut [u8]) -> Result<usize, String> {
        (**self).read_chunk(chunk)
    }

    fn wait(&mut self) -> Result<(), String> {
        (**self).wait()
    }
}

pub struct SseTransportDriver<S = ProviderResponseStream> {
    stream: S,
    runtime: Arc<Mutex<SkeletonRuntime>>,
    processor: ResponseStreamProcessor,
    ingress: SseIngressPlugin,
    egress: SseEgressPlugin,
    committed: bool,
    pending_client_frames: std::collections::VecDeque<SseTransportFrame>,
    close_after_pending: bool,
    request: HttpRequest,
    provider: String,
    model: String,
    timing: V4RuntimeTimingSummary,
}

impl<S: ProviderSseSource> SseTransportDriver<S> {
    pub fn new(
        stream: S,
        runtime: Arc<Mutex<SkeletonRuntime>>,
        processor: ResponseStreamProcessor,
        request: HttpRequest,
        provider: String,
        model: String,
        timing: V4RuntimeTimingSummary,
    ) -> Self {
        let (ingress, egress) = production_transport_pair(std::time::Instant::now())
            .expect("constant SSE transport policy");
        Self {
            stream,
            runtime,
            processor,
            ingress,
            egress,
            committed: false,
            pending_client_frames: std::collections::VecDeque::new(),
            close_after_pending: false,
            request,
            provider,
            model,
            timing,
        }
    }

    fn commit_attempt(&mut self) -> Result<(), RuntimeFault> {
        let mut staged_bytes = 0usize;
        loop {
            let read_started = std::time::Instant::now();
            let mut bytes = [0u8; 8192];
            let count = self.stream.read_chunk(&mut bytes).map_err(|error| {
                RuntimeFault::new(
                    "provider_sse_read",
                    format!("provider SSE read failed: {error}"),
                )
            })?;
            self.timing
                .state()
                .record_phase("provider_read", read_started.elapsed().as_micros());
            if count == 0 {
                self.ingress.finish().map_err(|error| match error {
                    SseTransportError::IncompleteFrame => RuntimeFault::new(
                        "provider_sse_incomplete_frame",
                        "incomplete provider SSE frame at end of stream",
                    ),
                    other => RuntimeFault::new(
                        "provider_sse_transport",
                        format!("provider SSE framing failed: {other:?}"),
                    ),
                })?;
                self.stream.wait().map_err(|error| {
                    RuntimeFault::new(
                        "provider_sse_closeout",
                        format!("provider SSE closeout failed: {error}"),
                    )
                })?;
                self.timing
                    .finish_external()
                    .map_err(|message| RuntimeFault::new("runtime_timing", message))?;
                self.processor.finish()?;
                self.timing
                    .finish_runtime()
                    .map_err(|message| RuntimeFault::new("runtime_timing", message))?;
                return Ok(());
            }
            let framing_started = std::time::Instant::now();
            let frames = self
                .ingress
                .push_chunk(&bytes[..count], std::time::Instant::now())
                .map_err(|error| {
                    RuntimeFault::new(
                        "provider_sse_transport",
                        format!("provider SSE framing failed: {error:?}"),
                    )
                })?;
            self.timing.state().record_phase(
                "provider_sse_framing",
                framing_started.elapsed().as_micros(),
            );
            for frame in frames {
                staged_bytes = staged_bytes.saturating_add(frame.len());
                if staged_bytes > MAX_PROVIDER_ATTEMPT_BYTES {
                    return Err(RuntimeFault::new(
                        "provider_sse_staging_limit",
                        "provider SSE attempt exceeded bounded staging",
                    ));
                }
                let processing_started = std::time::Instant::now();
                let runtime = self.runtime.lock().map_err(|_| {
                    RuntimeFault::new("response_runtime_lock", "response runtime lock poisoned")
                })?;
                let disposition = match self
                    .processor
                    .execute_provider_response_scoped(&runtime, frame)
                {
                    Ok((disposition, report)) => {
                        if let Some(report) = report {
                            emit_payload_console_events(
                                &report.trace,
                                &self.request,
                                &self.request.path,
                                &self.provider,
                                &self.model,
                                true,
                                None,
                                std::time::Duration::ZERO,
                            );
                            if report.client_frame.is_none() {
                                return Err(RuntimeFault::new(
                                    "response_frame_missing",
                                    "response chain produced no client frame",
                                ));
                            }
                        }
                        disposition
                    }
                    Err(fault) => return Err(fault),
                };
                drop(runtime);
                self.timing.state().record_phase(
                    "response_processing",
                    processing_started.elapsed().as_micros(),
                );
                match disposition {
                    ResponseStreamDisposition::Continue { frame } => {
                        self.pending_client_frames.push_back(frame);
                    }
                    ResponseStreamDisposition::Terminal { frame } => {
                        self.pending_client_frames.push_back(frame);
                        self.stream.wait().map_err(|error| {
                            RuntimeFault::new(
                                "provider_sse_closeout",
                                format!("provider SSE closeout failed: {error}"),
                            )
                        })?;
                        self.timing
                            .finish_external()
                            .map_err(|message| RuntimeFault::new("runtime_timing", message))?;
                        self.timing
                            .finish_runtime()
                            .map_err(|message| RuntimeFault::new("runtime_timing", message))?;
                        return Ok(());
                    }
                    ResponseStreamDisposition::Failure { frame } => {
                        self.pending_client_frames.clear();
                        self.pending_client_frames.push_back(frame);
                        self.close_after_pending = true;
                        self.timing
                            .finish_external()
                            .map_err(|message| RuntimeFault::new("runtime_timing", message))?;
                        return Ok(());
                    }
                }
            }
        }
    }
}

impl<S: ProviderSseSource> ResponseStream for SseTransportDriver<S> {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        if !self.committed {
            match self.commit_attempt() {
                Ok(()) => {}
                Err(fault) => {
                    self.timing
                        .finish_external_if_active()
                        .map_err(std::io::Error::other)?;
                    self.egress.drain_closeout();
                    let runtime = self
                        .runtime
                        .lock()
                        .map_err(|_| std::io::Error::other("response runtime lock poisoned"))?;
                    let disposition = self
                        .processor
                        .project_failure(&runtime, fault)
                        .map_err(|error| std::io::Error::other(error.to_string()))?;
                    let ResponseStreamDisposition::Failure { frame } = disposition else {
                        return Err(std::io::Error::other(
                            "provider failure did not project a client failure frame",
                        ));
                    };
                    self.close_after_pending = true;
                    self.pending_client_frames.clear();
                    self.pending_client_frames.push_back(frame);
                }
            }
            self.committed = true;
        }
        match self.egress.pop() {
            Some(frame) => {
                chunk.extend_from_slice(frame.as_bytes());
                return Ok(true);
            }
            None => {
                if let Some(frame) = self.pending_client_frames.pop_front() {
                    self.egress
                        .enqueue(frame, std::time::Instant::now())
                        .map_err(|error| {
                            std::io::Error::other(format!("client SSE transport failed: {error:?}"))
                        })?;
                    if let Some(frame) = self.egress.pop() {
                        chunk.extend_from_slice(frame.as_bytes());
                        return Ok(true);
                    }
                }
            }
        }
        if self.close_after_pending {
            return Ok(false);
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extend_bounded_attempt, frames_after_terminal, production_transport_pair,
        NativeProviderSseSource, ProviderSseSource, MAX_PROVIDER_ATTEMPT_BYTES,
    };
    use routecodex_v4_provider::NativeProviderTransport;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn bounded_attempt_rejects_growth_past_limit() {
        let mut attempt = vec![0u8; MAX_PROVIDER_ATTEMPT_BYTES];
        extend_bounded_attempt(&mut attempt, &[]).expect("exact limit is allowed");
        let error =
            extend_bounded_attempt(&mut attempt, &[0]).expect_err("one byte past limit fails");
        assert_eq!(error, "provider SSE attempt exceeded bounded staging");
    }

    #[test]
    fn frames_after_terminal_reject_same_chunk_trailing_frame() {
        let (mut ingress, _) =
            production_transport_pair(std::time::Instant::now()).expect("transport pair");
        let frames = ingress
            .push_chunk(
                concat!(
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"late\"}\n\n",
                )
                .as_bytes(),
                std::time::Instant::now(),
            )
            .expect("complete frames");
        assert!(frames_after_terminal(&mut ingress, &frames, 0).expect("trailing frame result"));
    }

    #[test]
    fn frames_after_terminal_reject_partial_same_chunk_trailing_bytes() {
        let (mut ingress, _) =
            production_transport_pair(std::time::Instant::now()).expect("transport pair");
        let frames = ingress
            .push_chunk(
                concat!(
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                    "event: response.output_text.delta\n",
                )
                .as_bytes(),
                std::time::Instant::now(),
            )
            .expect("terminal frame");
        assert!(frames_after_terminal(&mut ingress, &frames, 0).expect("trailing bytes result"));
    }

    #[test]
    fn frames_after_terminal_accept_terminal_without_trailing_bytes() {
        let (mut ingress, _) =
            production_transport_pair(std::time::Instant::now()).expect("transport pair");
        let frames = ingress
            .push_chunk(
                concat!(
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
                )
                .as_bytes(),
                std::time::Instant::now(),
            )
            .expect("terminal frame");
        assert!(!frames_after_terminal(&mut ingress, &frames, 0).expect("clean terminal result"));
    }

    #[test]
    fn cancelled_attempt_does_not_drain_provider_until_terminal() {
        let provider = TcpListener::bind("127.0.0.1:0").expect("provider listener");
        let address = provider.local_addr().expect("provider address");
        let provider_thread = std::thread::spawn(move || {
            let (mut stream, _) = provider.accept().expect("provider accepts");
            let mut request = [0u8; 8192];
            let _ = stream.read(&mut request);
            let body = concat!(
                "event: response.output_text.delta\n",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\"}\n\n",
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\n\r\n{:x}\r\n{}\r\n",
                body.len(),
                body
            )
            .expect("provider headers and first frame");
            stream.flush().expect("provider first frame flush");
            std::thread::sleep(Duration::from_secs(2));
            let terminal = concat!(
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"late\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"mock-model\",\"output\":[]}}\n\n",
            );
            let _ = write!(
                stream,
                "{:x}\r\n{}\r\n0\r\n\r\n",
                terminal.len(),
                terminal
            );
        });
        let config = std::env::temp_dir().join(format!(
            "v4-provider-cancel-attempt-{}-{}.toml",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(
            &config,
            format!(
                r#"
providerId = "mock"

[provider]
baseURL = "http://{address}"
defaultModel = "mock-model"
type = "responses"

[provider.auth]
apiKey = "test-key"

[provider.models.mock-model]
wire_name = "mock-model"
"#
            ),
        )
        .expect("provider config");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("provider runtime");
        let cancellation = CancellationToken::new();
        let transport =
            NativeProviderTransport::new(Duration::from_secs(5), 1024 * 1024).expect("transport");
        let stream = runtime
            .block_on(transport.send_streaming(
                config.to_str().expect("provider config path"),
                "responses",
                "responses",
                &json!({"stream": true}),
                cancellation.clone(),
            ))
            .expect("provider stream");
        let mut source =
            NativeProviderSseSource::new(stream, cancellation.clone(), runtime.handle().clone());
        let mut first = [0u8; 8192];
        assert!(
            ProviderSseSource::read_chunk(&mut source, &mut first).expect("first chunk") > 0
        );
        cancellation.cancel();
        let started = std::time::Instant::now();
        let error = source
            .read_attempt_until_terminal("responses")
            .expect_err("cancelled attempt must fail");
        assert_eq!(
            error,
            "provider_transport_cancelled: provider stream cancelled"
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "cancellation must not wait for the provider terminal"
        );
        provider_thread.join().expect("provider thread");
        std::fs::remove_file(config).ok();
    }
}
