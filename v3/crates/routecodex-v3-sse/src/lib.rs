//! Protocol-neutral incremental SSE framing for RouteCodex V3.
//!
//! This crate is copied into the V3 workspace so V3 can run without depending on the V2 llmswitch-core crate tree.
//! It deliberately does not interpret event names or `data` payloads.
// feature_id: v3.sse_transport_core_independent

use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SseTransportLimits {
    pub max_line_bytes: usize,
    pub max_frame_bytes: usize,
    pub max_buffer_bytes: usize,
}

impl Default for SseTransportLimits {
    fn default() -> Self {
        Self {
            max_line_bytes: 64 * 1024,
            max_frame_bytes: 1024 * 1024,
            max_buffer_bytes: 2 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SseTransportError {
    #[error("SSE input is not valid UTF-8")]
    InvalidUtf8,
    #[error("SSE stream ended before the final frame delimiter")]
    UnterminatedFrame,
    #[error("SSE line exceeds {limit} bytes")]
    LineLimitExceeded { limit: usize },
    #[error("SSE frame exceeds {limit} bytes")]
    FrameLimitExceeded { limit: usize },
    #[error("SSE decoder buffer exceeds {limit} bytes")]
    BufferLimitExceeded { limit: usize },
    #[error("SSE transport aborted")]
    Aborted,
    #[error("SSE transport timed out after {timeout:?}")]
    Timeout { timeout: Duration },
    #[error("SSE upstream read failed: {message}")]
    UpstreamRead { message: String },
    #[error("SSE downstream write failed: {message}")]
    DownstreamWrite { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SseTransportLifecycleState {
    Flowing,
    Paused,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseTransportLifecycleEvent {
    DownstreamWriteAccepted,
    DownstreamWriteBlocked,
    DownstreamDrain,
    UpstreamEof,
    Abort,
    Timeout(Duration),
    UpstreamReadFailed(String),
    DownstreamWriteFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseTransportLifecycleEffect {
    StillRunning,
    PauseUpstream,
    ResumeUpstream,
    CloseAndRelease(Result<(), SseTransportError>),
    AlreadyTerminal(Result<(), SseTransportError>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportLifecycle {
    state: SseTransportLifecycleState,
    terminal_result: Option<Result<(), SseTransportError>>,
}

impl Default for SseTransportLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl SseTransportLifecycle {
    pub fn new() -> Self {
        Self {
            state: SseTransportLifecycleState::Flowing,
            terminal_result: None,
        }
    }

    pub fn state(&self) -> SseTransportLifecycleState {
        self.state
    }

    pub fn is_released(&self) -> bool {
        self.state == SseTransportLifecycleState::Closed
    }

    pub fn apply(&mut self, event: SseTransportLifecycleEvent) -> SseTransportLifecycleEffect {
        if let Some(result) = &self.terminal_result {
            return SseTransportLifecycleEffect::AlreadyTerminal(result.clone());
        }

        match event {
            SseTransportLifecycleEvent::DownstreamWriteBlocked
                if self.state == SseTransportLifecycleState::Flowing =>
            {
                self.state = SseTransportLifecycleState::Paused;
                SseTransportLifecycleEffect::PauseUpstream
            }
            SseTransportLifecycleEvent::DownstreamDrain
                if self.state == SseTransportLifecycleState::Paused =>
            {
                self.state = SseTransportLifecycleState::Flowing;
                SseTransportLifecycleEffect::ResumeUpstream
            }
            SseTransportLifecycleEvent::DownstreamWriteAccepted
            | SseTransportLifecycleEvent::DownstreamWriteBlocked
            | SseTransportLifecycleEvent::DownstreamDrain => {
                SseTransportLifecycleEffect::StillRunning
            }
            SseTransportLifecycleEvent::UpstreamEof => self.close(Ok(())),
            SseTransportLifecycleEvent::Abort => self.close(Err(SseTransportError::Aborted)),
            SseTransportLifecycleEvent::Timeout(timeout) => {
                self.close(Err(SseTransportError::Timeout { timeout }))
            }
            SseTransportLifecycleEvent::UpstreamReadFailed(message) => {
                self.close(Err(SseTransportError::UpstreamRead { message }))
            }
            SseTransportLifecycleEvent::DownstreamWriteFailed(message) => {
                self.close(Err(SseTransportError::DownstreamWrite { message }))
            }
        }
    }

    fn close(&mut self, result: Result<(), SseTransportError>) -> SseTransportLifecycleEffect {
        self.state = SseTransportLifecycleState::Closed;
        self.terminal_result = Some(result.clone());
        SseTransportLifecycleEffect::CloseAndRelease(result)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseField {
    Comment(String),
    Named { name: String, value: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportIn01RawChunk<'a> {
    bytes: &'a [u8],
}

pub type V3SseTransportIn01RawChunk<'a> = SseTransportIn01RawChunk<'a>;

pub fn build_sse_transport_in_01_raw_chunk(bytes: &[u8]) -> SseTransportIn01RawChunk<'_> {
    SseTransportIn01RawChunk { bytes }
}

pub fn build_v3_sse_transport_in_01_raw_chunk(bytes: &[u8]) -> SseTransportIn01RawChunk<'_> {
    build_sse_transport_in_01_raw_chunk(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportIn02DecodedFrame {
    fields: Vec<SseField>,
}

pub type V3SseTransportIn02DecodedFrame = SseTransportIn02DecodedFrame;

impl SseTransportIn02DecodedFrame {
    pub fn fields(&self) -> &[SseField] {
        &self.fields
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportIn03ValidatedFrameStream {
    frame: SseTransportIn02DecodedFrame,
}

pub type V3SseTransportIn03ValidatedFrameStream = SseTransportIn03ValidatedFrameStream;

impl SseTransportIn03ValidatedFrameStream {
    pub fn frame(&self) -> &SseTransportIn02DecodedFrame {
        &self.frame
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportOut04EncodedChunk(Vec<u8>);

pub type V3SseTransportOut04EncodedChunk = SseTransportOut04EncodedChunk;

impl SseTransportOut04EncodedChunk {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

#[derive(Debug)]
pub struct SseIncrementalDecoder {
    limits: SseTransportLimits,
    buffer: Vec<u8>,
    scan_index: usize,
    line_start: usize,
}

impl SseIncrementalDecoder {
    pub fn new(limits: SseTransportLimits) -> Self {
        Self {
            limits,
            buffer: Vec::new(),
            scan_index: 0,
            line_start: 0,
        }
    }

    pub fn push(
        &mut self,
        raw_chunk: SseTransportIn01RawChunk<'_>,
    ) -> Result<Vec<SseTransportIn03ValidatedFrameStream>, SseTransportError> {
        let mut frames = Vec::new();
        for byte in raw_chunk.bytes {
            self.buffer.push(*byte);
            if self.buffer.len() > self.limits.max_buffer_bytes {
                return Err(SseTransportError::BufferLimitExceeded {
                    limit: self.limits.max_buffer_bytes,
                });
            }
            loop {
                let mut frame_end = None;
                while self.scan_index < self.buffer.len() {
                    let ending_len = match self.buffer[self.scan_index] {
                        b'\n' => 1,
                        b'\r' if self.buffer.get(self.scan_index + 1) == Some(&b'\n') => 2,
                        b'\r' if self.buffer.get(self.scan_index + 1).is_none() => break,
                        b'\r' => 1,
                        _ => {
                            self.scan_index += 1;
                            if self.scan_index.saturating_sub(self.line_start)
                                > self.limits.max_line_bytes
                            {
                                return Err(SseTransportError::LineLimitExceeded {
                                    limit: self.limits.max_line_bytes,
                                });
                            }
                            continue;
                        }
                    };
                    if self.scan_index.saturating_sub(self.line_start) > self.limits.max_line_bytes
                    {
                        return Err(SseTransportError::LineLimitExceeded {
                            limit: self.limits.max_line_bytes,
                        });
                    }
                    if self.scan_index == self.line_start {
                        frame_end = Some(self.scan_index + ending_len);
                        break;
                    }
                    self.scan_index += ending_len;
                    self.line_start = self.scan_index;
                }
                let Some(end) = frame_end else { break };
                if end > self.limits.max_frame_bytes {
                    return Err(SseTransportError::FrameLimitExceeded {
                        limit: self.limits.max_frame_bytes,
                    });
                }
                let raw = self.buffer.drain(..end).collect::<Vec<_>>();
                self.scan_index = 0;
                self.line_start = 0;
                frames.push(build_sse_transport_in_03_from_sse_transport_in_02(
                    build_sse_transport_in_02_from_sse_transport_in_01(&raw, self.limits)?,
                )?);
            }
            if self.buffer.len() > self.limits.max_frame_bytes {
                return Err(SseTransportError::FrameLimitExceeded {
                    limit: self.limits.max_frame_bytes,
                });
            }
        }
        Ok(frames)
    }

    pub fn remaining_bytes(&self) -> &[u8] {
        &self.buffer
    }

    pub fn finish(self) -> Result<(), SseTransportError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(SseTransportError::UnterminatedFrame)
        }
    }
}

pub fn build_sse_transport_out_04_from_sse_transport_in_03(
    frame: &SseTransportIn03ValidatedFrameStream,
) -> SseTransportOut04EncodedChunk {
    let mut output = Vec::new();
    for field in frame.frame.fields() {
        match field {
            SseField::Comment(value) => {
                output.push(b':');
                output.extend_from_slice(value.as_bytes());
            }
            SseField::Named { name, value } => {
                output.extend_from_slice(name.as_bytes());
                output.push(b':');
                if !value.is_empty() {
                    output.push(b' ');
                    output.extend_from_slice(value.as_bytes());
                }
            }
        }
        output.push(b'\n');
    }
    output.push(b'\n');
    SseTransportOut04EncodedChunk(output)
}

pub fn build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(
    frame: &SseTransportIn03ValidatedFrameStream,
) -> SseTransportOut04EncodedChunk {
    build_sse_transport_out_04_from_sse_transport_in_03(frame)
}

pub fn build_sse_transport_in_02_from_fields(
    fields: Vec<SseField>,
) -> Result<SseTransportIn02DecodedFrame, SseTransportError> {
    Ok(SseTransportIn02DecodedFrame { fields })
}

pub fn build_v3_sse_transport_in_02_from_fields(
    fields: Vec<SseField>,
) -> Result<SseTransportIn02DecodedFrame, SseTransportError> {
    build_sse_transport_in_02_from_fields(fields)
}

pub fn build_sse_transport_in_03_from_sse_transport_in_02(
    frame: SseTransportIn02DecodedFrame,
) -> Result<SseTransportIn03ValidatedFrameStream, SseTransportError> {
    Ok(SseTransportIn03ValidatedFrameStream { frame })
}

pub fn build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(
    frame: SseTransportIn02DecodedFrame,
) -> Result<SseTransportIn03ValidatedFrameStream, SseTransportError> {
    build_sse_transport_in_03_from_sse_transport_in_02(frame)
}

pub fn build_sse_transport_out_04_keepalive_comment(
    comment: &str,
) -> SseTransportOut04EncodedChunk {
    SseTransportOut04EncodedChunk(format!(":{}\n\n", comment).into_bytes())
}

pub fn build_v3_sse_transport_out_04_keepalive_comment(
    comment: &str,
) -> SseTransportOut04EncodedChunk {
    build_sse_transport_out_04_keepalive_comment(comment)
}

fn build_sse_transport_in_02_from_sse_transport_in_01(
    raw: &[u8],
    limits: SseTransportLimits,
) -> Result<SseTransportIn02DecodedFrame, SseTransportError> {
    let text = std::str::from_utf8(raw).map_err(|_| SseTransportError::InvalidUtf8)?;
    let body = text.trim_end_matches(['\r', '\n']);
    let mut fields = Vec::new();
    for line in body.split(['\n', '\r']).filter(|line| !line.is_empty()) {
        if line.len() > limits.max_line_bytes {
            return Err(SseTransportError::LineLimitExceeded {
                limit: limits.max_line_bytes,
            });
        }
        if let Some(comment) = line.strip_prefix(':') {
            fields.push(SseField::Comment(comment.to_string()));
            continue;
        }
        let (name, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        fields.push(SseField::Named {
            name: name.to_string(),
            value: value.to_string(),
        });
    }
    Ok(SseTransportIn02DecodedFrame { fields })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_utf8_chunks_preserve_multiline_comment_id_retry_and_unknown_fields() {
        let input = "event: custom\r\nid: 7\r\nretry: 50\r\n:note\r\ndata: 你\r\ndata: 好\r\nx-extra: value\r\n\r\n".as_bytes();
        for split in 0..=input.len() {
            let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
            let mut frames = decoder
                .push(build_sse_transport_in_01_raw_chunk(&input[..split]))
                .unwrap();
            frames.extend(
                decoder
                    .push(build_sse_transport_in_01_raw_chunk(&input[split..]))
                    .unwrap(),
            );
            decoder.finish().unwrap();
            assert_eq!(frames.len(), 1, "split={split}");
            let encoded = build_sse_transport_out_04_from_sse_transport_in_03(&frames[0]);
            let text = std::str::from_utf8(encoded.as_bytes()).unwrap();
            assert!(text.contains("data: 你\ndata: 好\n"));
            assert!(text.contains("x-extra: value\n"));
        }
    }

    #[test]
    fn done_is_opaque_data_and_no_terminal_is_synthesized() {
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(b"data: [DONE]\n\n"))
            .unwrap();
        decoder.finish().unwrap();
        assert_eq!(
            build_sse_transport_out_04_from_sse_transport_in_03(&frames[0]).as_bytes(),
            b"data: [DONE]\n\n"
        );
    }

    #[test]
    fn long_chunk_is_drained_frame_by_frame_under_buffer_budget() {
        let limits = SseTransportLimits {
            max_line_bytes: 16,
            max_frame_bytes: 16,
            max_buffer_bytes: 16,
        };
        let mut decoder = SseIncrementalDecoder::new(limits);
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(
                b"data: 1\n\ndata: 2\n\ndata: 3\n\n",
            ))
            .unwrap();
        decoder.finish().unwrap();
        assert_eq!(frames.len(), 3);
    }

    #[test]
    fn rejects_unterminated_invalid_utf8_and_limits() {
        let mut unfinished = SseIncrementalDecoder::new(SseTransportLimits::default());
        unfinished
            .push(build_sse_transport_in_01_raw_chunk(b"data: half"))
            .unwrap();
        assert_eq!(
            unfinished.finish(),
            Err(SseTransportError::UnterminatedFrame)
        );

        let mut invalid = SseIncrementalDecoder::new(SseTransportLimits::default());
        assert_eq!(
            invalid.push(build_sse_transport_in_01_raw_chunk(b"data: \xff\n\n")),
            Err(SseTransportError::InvalidUtf8)
        );

        let limits = SseTransportLimits {
            max_line_bytes: 4,
            max_frame_bytes: 32,
            max_buffer_bytes: 64,
        };
        let mut oversized = SseIncrementalDecoder::new(limits);
        assert_eq!(
            oversized.push(build_sse_transport_in_01_raw_chunk(b"data: x\n\n")),
            Err(SseTransportError::LineLimitExceeded { limit: 4 })
        );
    }

    #[test]
    fn lifecycle_pauses_on_backpressure_and_resumes_only_after_drain() {
        let mut lifecycle = SseTransportLifecycle::new();
        assert_eq!(
            lifecycle.apply(SseTransportLifecycleEvent::DownstreamWriteBlocked),
            SseTransportLifecycleEffect::PauseUpstream
        );
        assert_eq!(lifecycle.state(), SseTransportLifecycleState::Paused);
        assert_eq!(
            lifecycle.apply(SseTransportLifecycleEvent::DownstreamDrain),
            SseTransportLifecycleEffect::ResumeUpstream
        );
        assert_eq!(lifecycle.state(), SseTransportLifecycleState::Flowing);
    }

    #[test]
    fn lifecycle_success_and_failures_close_and_release_exactly_once() {
        let cases = [
            (SseTransportLifecycleEvent::UpstreamEof, Ok(())),
            (
                SseTransportLifecycleEvent::Abort,
                Err(SseTransportError::Aborted),
            ),
            (
                SseTransportLifecycleEvent::Timeout(Duration::from_secs(3)),
                Err(SseTransportError::Timeout {
                    timeout: Duration::from_secs(3),
                }),
            ),
            (
                SseTransportLifecycleEvent::UpstreamReadFailed("read".to_string()),
                Err(SseTransportError::UpstreamRead {
                    message: "read".to_string(),
                }),
            ),
            (
                SseTransportLifecycleEvent::DownstreamWriteFailed("write".to_string()),
                Err(SseTransportError::DownstreamWrite {
                    message: "write".to_string(),
                }),
            ),
        ];
        for (event, expected) in cases {
            let mut lifecycle = SseTransportLifecycle::new();
            assert_eq!(
                lifecycle.apply(event),
                SseTransportLifecycleEffect::CloseAndRelease(expected.clone())
            );
            assert_eq!(
                lifecycle.apply(SseTransportLifecycleEvent::Abort),
                SseTransportLifecycleEffect::AlreadyTerminal(expected)
            );
        }
    }

    #[test]
    fn lifecycle_non_terminal_events_never_close_or_release() {
        let mut lifecycle = SseTransportLifecycle::new();
        assert_eq!(
            lifecycle.apply(SseTransportLifecycleEvent::DownstreamWriteAccepted),
            SseTransportLifecycleEffect::StillRunning
        );
        assert_eq!(lifecycle.state(), SseTransportLifecycleState::Flowing);
        assert!(!lifecycle.is_released());
    }
}
