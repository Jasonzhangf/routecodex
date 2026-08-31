use futures_util::Stream;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

const V3_COMMITTED_SSE_ATTEMPT_MAX_BYTES: usize = 64 * 1024 * 1024;
const V3_COMMITTED_SSE_ATTEMPT_MAX_FRAMES: usize = 262_144;
const V3_COMMITTED_SSE_REQUEST_MAX_BYTES: usize = 64 * 1024 * 1024;
const V3_COMMITTED_SSE_PROCESS_MAX_BYTES: usize = 512 * 1024 * 1024;
const V3_COMMITTED_SSE_RESIDENCE_TIMEOUT: Duration = Duration::from_secs(600);
static V3_COMMITTED_SSE_PROCESS_RESIDENT_BYTES: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3CommittedSseTerminal {
    Completed,
    Dropped,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct V3AttemptStoreLimits {
    pub(crate) request_max_attempts: usize,
    pub(crate) attempt_max_bytes: usize,
    pub(crate) attempt_max_frames: usize,
    pub(crate) request_max_bytes: usize,
    pub(crate) process_max_bytes: usize,
    pub(crate) residence_timeout: Duration,
}

impl Default for V3AttemptStoreLimits {
    fn default() -> Self {
        Self {
            request_max_attempts: 8,
            attempt_max_bytes: V3_COMMITTED_SSE_ATTEMPT_MAX_BYTES,
            attempt_max_frames: V3_COMMITTED_SSE_ATTEMPT_MAX_FRAMES,
            request_max_bytes: V3_COMMITTED_SSE_REQUEST_MAX_BYTES,
            process_max_bytes: V3_COMMITTED_SSE_PROCESS_MAX_BYTES,
            residence_timeout: V3_COMMITTED_SSE_RESIDENCE_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3AttemptStoreError {
    LocalResourceExhausted(String),
    InvalidAttemptState(String),
}

impl fmt::Display for V3AttemptStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LocalResourceExhausted(message) | Self::InvalidAttemptState(message) => {
                formatter.write_str(message)
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct V3AttemptBudget {
    inner: Arc<V3AttemptBudgetInner>,
}

/// Opaque request-local execution control carried across protocol handoffs.
/// The server may move this value but cannot inspect or reconstruct its
/// attempt count, resident-byte reservations, or deadline from payload data.
#[derive(Clone)]
pub struct V3RequestExecutionControl {
    attempt_budget: V3AttemptBudget,
}

impl fmt::Debug for V3RequestExecutionControl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("V3RequestExecutionControl(<opaque>)")
    }
}

impl V3RequestExecutionControl {
    pub(crate) fn from_manifest(
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
    ) -> Result<Self, V3AttemptStoreError> {
        Ok(Self {
            attempt_budget: V3AttemptBudget::from_manifest(manifest, server_id)?,
        })
    }

    pub(crate) fn attempt_budget(&self) -> V3AttemptBudget {
        self.attempt_budget.clone()
    }

    #[cfg(test)]
    pub(crate) fn transport_attempts(&self) -> usize {
        self.attempt_budget.transport_attempts()
    }
}

struct V3AttemptBudgetInner {
    limits: V3AttemptStoreLimits,
    transport_attempts: AtomicUsize,
    request_resident_bytes: AtomicUsize,
    process_resident_bytes: V3ProcessResidentBytes,
    deadline: Instant,
}

enum V3ProcessResidentBytes {
    Shared(&'static AtomicUsize),
    #[cfg(test)]
    Isolated(Arc<AtomicUsize>),
}

impl V3ProcessResidentBytes {
    fn counter(&self) -> &AtomicUsize {
        match self {
            Self::Shared(counter) => counter,
            #[cfg(test)]
            Self::Isolated(counter) => counter,
        }
    }
}

impl V3AttemptBudget {
    pub(crate) fn from_manifest(
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
    ) -> Result<Self, V3AttemptStoreError> {
        let server = manifest.servers.get(server_id).ok_or_else(|| {
            V3AttemptStoreError::InvalidAttemptState(format!(
                "attempt-store policy references unknown server {server_id}"
            ))
        })?;
        let policy = server
            .execution
            .as_ref()
            .map(|execution| &execution.attempt_store)
            .ok_or_else(|| {
                V3AttemptStoreError::InvalidAttemptState(format!(
                    "hub_v1 server {server_id} is missing compiled attempt-store policy"
                ))
            })?;
        let limits = V3AttemptStoreLimits {
            request_max_attempts: policy.request_max_attempts,
            attempt_max_bytes: policy.attempt_max_bytes,
            attempt_max_frames: policy.attempt_max_frames,
            request_max_bytes: policy.request_max_bytes,
            process_max_bytes: policy.process_max_bytes,
            residence_timeout: Duration::from_millis(policy.residence_timeout_ms),
        };
        Ok(Self::new(
            limits,
            V3ProcessResidentBytes::Shared(&V3_COMMITTED_SSE_PROCESS_RESIDENT_BYTES),
        ))
    }

    /// Synthetic protocol projections and tests only. Request execution must
    /// use `from_manifest` so runtime limits have one compiled config owner.
    pub(crate) fn process_default() -> Self {
        Self::new(
            V3AttemptStoreLimits::default(),
            V3ProcessResidentBytes::Shared(&V3_COMMITTED_SSE_PROCESS_RESIDENT_BYTES),
        )
    }

    fn new(limits: V3AttemptStoreLimits, process_resident_bytes: V3ProcessResidentBytes) -> Self {
        Self {
            inner: Arc::new(V3AttemptBudgetInner {
                limits,
                transport_attempts: AtomicUsize::new(0),
                request_resident_bytes: AtomicUsize::new(0),
                process_resident_bytes,
                deadline: Instant::now() + limits.residence_timeout,
            }),
        }
    }

    #[cfg(test)]
    fn new_isolated(
        limits: V3AttemptStoreLimits,
        process_resident_bytes: Arc<AtomicUsize>,
    ) -> Self {
        Self::new(
            limits,
            V3ProcessResidentBytes::Isolated(process_resident_bytes),
        )
    }

    fn ensure_resident(&self) -> Result<(), V3AttemptStoreError> {
        if Instant::now() >= self.inner.deadline {
            return Err(V3AttemptStoreError::LocalResourceExhausted(
                "provider SSE attempt exceeded the request residence deadline".to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) fn admit_transport_attempt(&self) -> Result<usize, V3AttemptStoreError> {
        self.ensure_resident()?;
        self.inner
            .transport_attempts
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < self.inner.limits.request_max_attempts).then_some(current + 1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| {
                V3AttemptStoreError::LocalResourceExhausted(format!(
                    "request provider transport attempt limit {} exhausted",
                    self.inner.limits.request_max_attempts
                ))
            })
    }

    pub(crate) fn transport_attempts(&self) -> usize {
        self.inner.transport_attempts.load(Ordering::Acquire)
    }

    fn reserve(&self, bytes: usize) -> Result<(), V3AttemptStoreError> {
        self.ensure_resident()?;
        reserve_bounded(
            self.inner.process_resident_bytes.counter(),
            bytes,
            self.inner.limits.process_max_bytes,
            "process-global provider SSE resident byte limit",
        )?;
        if let Err(error) = reserve_bounded(
            &self.inner.request_resident_bytes,
            bytes,
            self.inner.limits.request_max_bytes,
            "request provider SSE resident byte limit",
        ) {
            self.inner
                .process_resident_bytes
                .counter()
                .fetch_sub(bytes, Ordering::AcqRel);
            return Err(error);
        }
        Ok(())
    }

    fn release(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        self.inner
            .request_resident_bytes
            .fetch_sub(bytes, Ordering::AcqRel);
        self.inner
            .process_resident_bytes
            .counter()
            .fetch_sub(bytes, Ordering::AcqRel);
    }

    #[cfg(test)]
    fn request_resident_bytes(&self) -> usize {
        self.inner.request_resident_bytes.load(Ordering::Acquire)
    }
}

fn reserve_bounded(
    counter: &AtomicUsize,
    bytes: usize,
    limit: usize,
    label: &str,
) -> Result<(), V3AttemptStoreError> {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(bytes).filter(|next| *next <= limit)
        })
        .map(|_| ())
        .map_err(|_| {
            V3AttemptStoreError::LocalResourceExhausted(format!(
                "provider SSE attempt exceeded the {label} ({limit})"
            ))
        })
}

struct V3AttemptReservation {
    budget: V3AttemptBudget,
    bytes: usize,
}

impl V3AttemptReservation {
    fn reserve(&mut self, bytes: usize) -> Result<(), V3AttemptStoreError> {
        self.budget.reserve(bytes)?;
        self.bytes = self.bytes.checked_add(bytes).ok_or_else(|| {
            self.budget.release(bytes);
            V3AttemptStoreError::LocalResourceExhausted(
                "provider SSE attempt reservation byte count overflowed".to_string(),
            )
        })?;
        Ok(())
    }
}

impl Drop for V3AttemptReservation {
    fn drop(&mut self) {
        self.budget.release(self.bytes);
    }
}

/// Runtime-sealed replay of one completely validated provider attempt.
///
/// The inner stream and constructor are intentionally private. Server/Front
/// code may consume or observe the replay, but cannot manufacture an empty or
/// terminal-incomplete stream and call it committed.
pub struct V3CommittedClientSseStream {
    inner: Pin<Box<dyn Stream<Item = Vec<u8>> + Send>>,
    next_frame_index: usize,
    terminal_frame_index: usize,
}

/// Runtime-issued proof that one provider attempt reached a protocol-valid
/// terminal and its complete client payload was sealed. The private field
/// prevents Server, Transport, diagnostics, and payload code from declaring
/// success from HTTP headers, a lazy stream, or an observation snapshot.
#[derive(Clone, Copy)]
pub struct V3AttemptSuccessReceipt {
    _runtime_sealed: (),
}

impl fmt::Debug for V3AttemptSuccessReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("V3AttemptSuccessReceipt(<runtime-sealed>)")
    }
}

impl V3AttemptSuccessReceipt {
    pub(crate) fn from_buffered_terminal_attempt() -> Self {
        Self {
            _runtime_sealed: (),
        }
    }

    pub(crate) fn from_sealed_sse_attempt(_sealed: &V3CommittedClientSseStream) -> Self {
        Self {
            _runtime_sealed: (),
        }
    }

    pub(crate) fn from_protocol_terminal_attempt() -> Self {
        Self {
            _runtime_sealed: (),
        }
    }
}

struct V3ReservedCommittedSseReplay {
    frames: std::vec::IntoIter<Vec<u8>>,
    _reservation: V3AttemptReservation,
}

impl Stream for V3ReservedCommittedSseReplay {
    type Item = Vec<u8>;

    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(self.frames.next())
    }
}

impl fmt::Debug for V3CommittedClientSseStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("V3CommittedClientSseStream(<sealed-replay>)")
    }
}

impl Stream for V3CommittedClientSseStream {
    type Item = Vec<u8>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(frame)) => {
                self.next_frame_index = self.next_frame_index.saturating_add(1);
                Poll::Ready(Some(frame))
            }
            terminal => terminal,
        }
    }
}

impl V3CommittedClientSseStream {
    pub fn observe(
        self,
        on_frame: impl Fn(&[u8]) + Send + Sync + 'static,
        on_terminal: impl FnOnce(V3CommittedSseTerminal) + Send + 'static,
    ) -> Self {
        let next_frame_index = self.next_frame_index;
        let terminal_frame_index = self.terminal_frame_index;
        Self {
            inner: Box::pin(V3ObservedCommittedSseStream {
                source: self,
                on_frame: Box::new(on_frame),
                on_terminal: Some(Box::new(on_terminal)),
            }),
            next_frame_index,
            terminal_frame_index,
        }
    }
}

struct V3ObservedCommittedSseStream {
    source: V3CommittedClientSseStream,
    on_frame: Box<dyn Fn(&[u8]) + Send + Sync>,
    on_terminal: Option<Box<dyn FnOnce(V3CommittedSseTerminal) + Send>>,
}

impl V3ObservedCommittedSseStream {
    fn finish(&mut self, terminal: V3CommittedSseTerminal) {
        if let Some(on_terminal) = self.on_terminal.take() {
            on_terminal(terminal);
        }
    }
}

impl Stream for V3ObservedCommittedSseStream {
    type Item = Vec<u8>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.source).poll_next(cx) {
            Poll::Ready(Some(frame)) => {
                (self.on_frame)(&frame);
                if self.source.next_frame_index > self.source.terminal_frame_index {
                    self.finish(V3CommittedSseTerminal::Completed);
                }
                Poll::Ready(Some(frame))
            }
            Poll::Ready(None) => {
                self.finish(V3CommittedSseTerminal::Completed);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for V3ObservedCommittedSseStream {
    fn drop(&mut self) {
        self.finish(V3CommittedSseTerminal::Dropped);
    }
}

/// Attempt-local bounded buffer owned by Runtime/Broker. Successful clean EOF
/// of the protocol-validating projected stream is the only call site allowed
/// to seal it into `V3CommittedClientSseStream`.
pub(crate) struct V3CommittedClientSseBuilder {
    frames: Vec<Vec<u8>>,
    byte_len: usize,
    terminal_frame_index: Option<usize>,
    limits: V3AttemptStoreLimits,
    reservation: V3AttemptReservation,
}

impl V3CommittedClientSseBuilder {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::with_budget(V3AttemptBudget::process_default())
            .expect("default attempt store budget must begin resident")
    }

    pub(crate) fn with_budget(budget: V3AttemptBudget) -> Result<Self, V3AttemptStoreError> {
        budget.ensure_resident()?;
        let limits = budget.inner.limits;
        Ok(Self {
            frames: Vec::new(),
            byte_len: 0,
            terminal_frame_index: None,
            limits,
            reservation: V3AttemptReservation { budget, bytes: 0 },
        })
    }

    pub(crate) fn push(&mut self, frame: Vec<u8>) -> Result<(), V3AttemptStoreError> {
        if frame.is_empty() {
            return Err(V3AttemptStoreError::InvalidAttemptState(
                "provider response event codec produced an empty frame".to_string(),
            ));
        }
        if self.frames.len() >= self.limits.attempt_max_frames {
            return Err(V3AttemptStoreError::LocalResourceExhausted(format!(
                "provider SSE attempt exceeded the committed replay frame limit ({})",
                self.limits.attempt_max_frames
            )));
        }
        let byte_len = self.byte_len.checked_add(frame.len()).ok_or_else(|| {
            V3AttemptStoreError::LocalResourceExhausted(
                "provider SSE attempt byte count overflowed".to_string(),
            )
        })?;
        if byte_len > self.limits.attempt_max_bytes {
            return Err(V3AttemptStoreError::LocalResourceExhausted(format!(
                "provider SSE attempt exceeded the committed replay byte limit ({})",
                self.limits.attempt_max_bytes
            )));
        }
        self.reservation.reserve(frame.len())?;
        self.byte_len = byte_len;
        self.frames.push(frame);
        Ok(())
    }

    pub(crate) fn mark_last_frame_as_terminal(&mut self) -> Result<(), V3AttemptStoreError> {
        self.reservation.budget.ensure_resident()?;
        let terminal_frame_index = self.frames.len().checked_sub(1).ok_or_else(|| {
            V3AttemptStoreError::InvalidAttemptState(
                "committed SSE terminal cannot precede every frame".to_string(),
            )
        })?;
        if self.terminal_frame_index.is_none() {
            self.terminal_frame_index = Some(terminal_frame_index);
        }
        Ok(())
    }

    pub(crate) fn seal_after_validated_terminal(
        self,
    ) -> Result<V3CommittedClientSseStream, V3AttemptStoreError> {
        self.reservation.budget.ensure_resident()?;
        if self.frames.is_empty() {
            return Err(V3AttemptStoreError::InvalidAttemptState(
                "provider response event codec produced an empty stream".to_string(),
            ));
        }
        let terminal_frame_index = self.terminal_frame_index.ok_or_else(|| {
            V3AttemptStoreError::InvalidAttemptState(
                "provider response event codec did not identify the committed terminal frame"
                    .to_string(),
            )
        })?;
        Ok(V3CommittedClientSseStream {
            inner: Box::pin(V3ReservedCommittedSseReplay {
                frames: self.frames.into_iter(),
                _reservation: self.reservation,
            }),
            next_frame_index: 0,
            terminal_frame_index,
        })
    }
}

#[cfg(test)]
mod tests;
