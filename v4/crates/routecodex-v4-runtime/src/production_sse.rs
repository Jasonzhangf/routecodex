//! Production SSE transport driver.
//!
//! This module owns only byte framing, queueing and lifecycle handoff.  It
//! delegates every semantic frame to `ResponseStreamProcessor`, which runs the
//! admitted response NodePluginPlan.  No JSON, model mapping, retry or
//! continuation decision is made by this transport driver.

use crate::{
    production_pipeline::emit_payload_console_events, ResponseStreamDisposition,
    ResponseStreamProcessor, RuntimeFault, SkeletonRuntime,
};
use routecodex_v4_provider::ProviderResponseStream;
use routecodex_v4_server::{HttpRequest, ResponseStream};
use routecodex_v4_standard_plugins::sse_transport::{
    production_transport_pair, SseEgressPlugin, SseIngressPlugin, SseTransportError,
};
use std::sync::{Arc, Mutex};

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

pub struct SseTransportDriver<S = ProviderResponseStream> {
    stream: S,
    runtime: Arc<Mutex<SkeletonRuntime>>,
    processor: ResponseStreamProcessor,
    ingress: SseIngressPlugin,
    egress: SseEgressPlugin,
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
            close_after_pending: false,
            request,
            provider,
            model,
        }
    }

    fn enqueue_disposition(
        &mut self,
        disposition: ResponseStreamDisposition,
    ) -> Result<(), std::io::Error> {
        let (frame, failed) = match disposition {
            ResponseStreamDisposition::Continue { frame }
            | ResponseStreamDisposition::Terminal { frame } => (frame, false),
            ResponseStreamDisposition::Failure { frame } => (frame, true),
        };
        self.egress
            .enqueue(frame, std::time::Instant::now())
            .map_err(|error| {
                std::io::Error::other(format!("client SSE transport failed: {error:?}"))
            })?;
        self.close_after_pending |= failed;
        Ok(())
    }

    fn enqueue_runtime_failure(&mut self, fault: RuntimeFault) -> Result<(), std::io::Error> {
        let disposition = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| std::io::Error::other("response runtime lock poisoned"))?;
            self.processor
                .project_failure(&runtime, fault)
                .map_err(|error| std::io::Error::other(error.to_string()))?
        };
        self.enqueue_disposition(disposition)
    }
}

impl<S: ProviderSseSource> ResponseStream for SseTransportDriver<S> {
    fn next_chunk(&mut self, chunk: &mut Vec<u8>) -> Result<bool, std::io::Error> {
        loop {
            if let Some(frame) = self.egress.pop() {
                chunk.extend_from_slice(frame.as_bytes());
                return Ok(true);
            }
            if self.close_after_pending {
                return Ok(false);
            }
            let mut bytes = [0u8; 8192];
            let count = match self.stream.read_chunk(&mut bytes) {
                Ok(count) => count,
                Err(error) => {
                    self.enqueue_runtime_failure(RuntimeFault::new(
                        "provider_sse_read",
                        format!("provider SSE read failed: {error}"),
                    ))?;
                    continue;
                }
            };
            if count == 0 {
                if let Err(error) = self.ingress.finish() {
                    let fault = match error {
                        SseTransportError::IncompleteFrame => RuntimeFault::new(
                            "provider_sse_incomplete_frame",
                            "incomplete provider SSE frame at end of stream",
                        ),
                        other => RuntimeFault::new(
                            "provider_sse_transport",
                            format!("provider SSE framing failed: {other:?}"),
                        ),
                    };
                    self.enqueue_runtime_failure(fault)?;
                    continue;
                }
                if let Err(error) = self.stream.wait() {
                    self.enqueue_runtime_failure(RuntimeFault::new(
                        "provider_sse_closeout",
                        format!("provider SSE closeout failed: {error}"),
                    ))?;
                    continue;
                }
                match self.processor.finish() {
                    Ok(()) => return Ok(false),
                    Err(fault) => {
                        self.enqueue_runtime_failure(fault)?;
                        continue;
                    }
                }
            }
            let frames = match self
                .ingress
                .push_chunk(&bytes[..count], std::time::Instant::now())
            {
                Ok(frames) => frames,
                Err(error) => {
                    self.enqueue_runtime_failure(RuntimeFault::new(
                        "provider_sse_transport",
                        format!("provider SSE framing failed: {error:?}"),
                    ))?;
                    continue;
                }
            };
            for frame in frames {
                let disposition = match self.runtime.lock() {
                    Ok(runtime) => match self
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
                                    Err(RuntimeFault::new(
                                        "response_frame_missing",
                                        "response chain produced no client frame",
                                    ))
                                } else {
                                    Ok(disposition)
                                }
                            } else {
                                Ok(disposition)
                            }
                        }
                        Err(fault) => Err(fault),
                    },
                    Err(_) => Err(RuntimeFault::new(
                        "response_runtime_lock",
                        "response runtime lock poisoned",
                    )),
                };
                match disposition {
                    Ok(disposition) => self.enqueue_disposition(disposition)?,
                    Err(fault) => {
                        self.enqueue_runtime_failure(fault)?;
                        break;
                    }
                }
            }
        }
    }
}
