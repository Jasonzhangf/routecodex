//! Production SSE transport driver.
//!
//! This module owns byte framing, full-attempt buffering, client queueing and
//! lifecycle handoff. Provider semantics and client projection are separate
//! owners: the provider attempt is materialized before any client frame is
//! enqueued.

use crate::{
    production_pipeline::emit_payload_console_events, ResponseStreamDisposition,
    ResponseStreamProcessor, RuntimeFault, SkeletonRuntime,
};
use routecodex_v4_provider::{NativeProviderResponseStream, ProviderResponseStream};
use routecodex_v4_server::{HttpRequest, ResponseStream};
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
}

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
}

impl<S: ProviderSseSource> SseTransportDriver<S> {
    pub fn new(
        stream: S,
        runtime: Arc<Mutex<SkeletonRuntime>>,
        processor: ResponseStreamProcessor,
        request: HttpRequest,
        provider: String,
        model: String,
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
        }
    }

    fn commit_attempt(&mut self) -> Result<(), RuntimeFault> {
        let mut staged_bytes = 0usize;
        loop {
            let mut bytes = [0u8; 8192];
            let count = self.stream.read_chunk(&mut bytes).map_err(|error| {
                RuntimeFault::new(
                    "provider_sse_read",
                    format!("provider SSE read failed: {error}"),
                )
            })?;
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
                self.processor.finish()?;
                return Ok(());
            }
            let frames = self
                .ingress
                .push_chunk(&bytes[..count], std::time::Instant::now())
                .map_err(|error| {
                    RuntimeFault::new(
                        "provider_sse_transport",
                        format!("provider SSE framing failed: {error:?}"),
                    )
                })?;
            for frame in frames {
                staged_bytes = staged_bytes.saturating_add(frame.len());
                if staged_bytes > MAX_PROVIDER_ATTEMPT_BYTES {
                    return Err(RuntimeFault::new(
                        "provider_sse_staging_limit",
                        "provider SSE attempt exceeded bounded staging",
                    ));
                }
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
                        return Ok(());
                    }
                    ResponseStreamDisposition::Failure { frame } => {
                        self.pending_client_frames.clear();
                        self.pending_client_frames.push_back(frame);
                        self.close_after_pending = true;
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
