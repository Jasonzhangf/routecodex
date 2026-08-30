//! Opaque SSE transport plugin.
//!
//! This owner frames and queues bytes. It never parses JSON, interprets event
//! types, decides business terminal state, or changes payload content.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SseTransportPolicy {
    max_buffer_bytes: usize,
    max_queued_bytes: usize,
    inactivity_timeout: Duration,
}

impl SseTransportPolicy {
    pub fn new(
        max_buffer_bytes: usize,
        max_queued_bytes: usize,
        inactivity_timeout: Duration,
    ) -> Result<Self, SseTransportError> {
        if max_buffer_bytes == 0 || max_queued_bytes == 0 || inactivity_timeout.is_zero() {
            return Err(SseTransportError::InvalidPolicy);
        }
        Ok(Self {
            max_buffer_bytes,
            max_queued_bytes,
            inactivity_timeout,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportFrame(Arc<[u8]>);

impl SseTransportFrame {
    pub fn from_complete_bytes(bytes: Vec<u8>) -> Result<Self, SseTransportError> {
        if !bytes.ends_with(b"\n\n") {
            return Err(SseTransportError::IncompleteFrame);
        }
        Ok(Self(bytes.into()))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseTransportError {
    InvalidPolicy,
    BufferLimitExceeded,
    Backpressure,
    InactivityTimeout,
    IncompleteFrame,
}

pub struct SseIngressPlugin {
    policy: SseTransportPolicy,
    buffer: Vec<u8>,
    last_activity: Instant,
}

impl SseIngressPlugin {
    pub fn new(policy: SseTransportPolicy, started_at: Instant) -> Self {
        Self {
            policy,
            buffer: Vec::new(),
            last_activity: started_at,
        }
    }

    pub fn push_chunk(
        &mut self,
        chunk: &[u8],
        now: Instant,
    ) -> Result<Vec<SseTransportFrame>, SseTransportError> {
        self.check_timeout(now)?;
        if self.buffer.len().saturating_add(chunk.len()) > self.policy.max_buffer_bytes {
            return Err(SseTransportError::BufferLimitExceeded);
        }
        self.buffer.extend_from_slice(chunk);
        self.last_activity = now;

        let mut frames = Vec::new();
        while let Some(end) = self.buffer.windows(2).position(|window| window == b"\n\n") {
            let complete_len = end + 2;
            let tail = self.buffer.split_off(complete_len);
            let complete = std::mem::replace(&mut self.buffer, tail);
            frames.push(SseTransportFrame::from_complete_bytes(complete)?);
        }
        Ok(frames)
    }

    pub fn finish(self) -> Result<(), SseTransportError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(SseTransportError::IncompleteFrame)
        }
    }

    fn check_timeout(&self, now: Instant) -> Result<(), SseTransportError> {
        if now.saturating_duration_since(self.last_activity) > self.policy.inactivity_timeout {
            Err(SseTransportError::InactivityTimeout)
        } else {
            Ok(())
        }
    }
}

pub struct SseEgressPlugin {
    policy: SseTransportPolicy,
    queue: VecDeque<SseTransportFrame>,
    queued_bytes: usize,
    last_activity: Instant,
}

impl SseEgressPlugin {
    pub fn new(policy: SseTransportPolicy, started_at: Instant) -> Self {
        Self {
            policy,
            queue: VecDeque::new(),
            queued_bytes: 0,
            last_activity: started_at,
        }
    }

    pub fn enqueue(
        &mut self,
        frame: SseTransportFrame,
        now: Instant,
    ) -> Result<(), SseTransportError> {
        if now.saturating_duration_since(self.last_activity) > self.policy.inactivity_timeout {
            return Err(SseTransportError::InactivityTimeout);
        }
        if self.queued_bytes.saturating_add(frame.len()) > self.policy.max_queued_bytes {
            return Err(SseTransportError::Backpressure);
        }
        self.queued_bytes += frame.len();
        self.queue.push_back(frame);
        self.last_activity = now;
        Ok(())
    }

    pub fn pop(&mut self) -> Option<SseTransportFrame> {
        let frame = self.queue.pop_front()?;
        self.queued_bytes -= frame.len();
        Some(frame)
    }

    pub fn keepalive_frame() -> SseTransportFrame {
        SseTransportFrame(Arc::from(&b": keepalive\n\n"[..]))
    }

    pub fn drain_closeout(&mut self) -> Vec<SseTransportFrame> {
        self.queued_bytes = 0;
        self.queue.drain(..).collect()
    }
}
