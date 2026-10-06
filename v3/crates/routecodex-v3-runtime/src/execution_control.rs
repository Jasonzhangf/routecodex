use futures_util::Stream;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use crate::operation_runner::{V3RequestContextHandle, V3RequestFinalizerGuard};

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

/// Runtime-side disposition for one already projected SSE frame.
///
/// The disposition is control state, not protocol payload.  Protocol codecs
/// classify it; the Runtime attempt collector consumes it to decide when the
/// provider attempt may be sealed and released to the Front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3SseFrameDisposition {
    Continue,
    SemanticTerminal,
    LegalCloseout,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct V3SseAttemptFrame {
    pub(crate) bytes: Vec<u8>,
    pub(crate) disposition: V3SseFrameDisposition,
}

impl V3SseAttemptFrame {
    pub(crate) fn new(bytes: Vec<u8>, disposition: V3SseFrameDisposition) -> Self {
        Self { bytes, disposition }
    }
}

impl AsRef<[u8]> for V3SseAttemptFrame {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

impl std::ops::Deref for V3SseAttemptFrame {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        &self.bytes
    }
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
    request_context: V3RequestContextHandle,
    request_finalizer: Arc<Mutex<Option<V3RequestFinalizerGuard>>>,
}

impl fmt::Debug for V3RequestExecutionControl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("V3RequestExecutionControl(<opaque>)")
    }
}

impl V3RequestExecutionControl {
    pub fn new(
        manifest: &routecodex_v3_config::V3Config05ManifestPublished,
        server_id: &str,
        request_id: &str,
        entry_protocol: &str,
    ) -> Result<Self, String> {
        if request_id.trim().is_empty() {
            return Err("request execution control requires a non-empty request id".to_string());
        }
        if entry_protocol.trim().is_empty() {
            return Err(
                "request execution control requires a non-empty entry protocol".to_string(),
            );
        }
        let request_context =
            V3RequestContextHandle::new(request_id.to_string(), entry_protocol.to_string());
        let request_finalizer = request_context.take_finalizer()?;
        Ok(Self {
            attempt_budget: V3AttemptBudget::from_manifest(manifest, server_id)
                .map_err(|error| error.to_string())?,
            request_context,
            request_finalizer: Arc::new(Mutex::new(Some(request_finalizer))),
        })
    }

    pub(crate) fn attempt_budget(&self) -> V3AttemptBudget {
        self.attempt_budget.clone()
    }

    /// Observes the exact request-scope identity without owning its terminal.
    pub fn request_context(&self) -> &V3RequestContextHandle {
        &self.request_context
    }

    /// Moves the one non-cloneable request-scope guard out of this control.
    ///
    /// The real Runtime future calls this before its first await so a later
    /// cancellation releases the scope even while ordinary control clones stay
    /// alive. A second take is an explicit invariant failure.
    pub fn take_request_finalizer(&self) -> Result<V3RequestFinalizerGuard, String> {
        let mut slot = self.request_finalizer.lock().map_err(|_| {
            format!(
                "request {} finalizer slot lock poisoned",
                self.request_context.request_id()
            )
        })?;
        slot.take().ok_or_else(|| {
            format!(
                "request {} finalizer guard already moved",
                self.request_context.request_id()
            )
        })
    }

    /// Moves the same guard back onto the control for a typed Direct/Relay
    /// handoff. The next Runtime future takes it again before awaiting.
    ///
    /// On failure the guard is returned so the caller can keep it on the
    /// existing typed error output instead of silently dropping it.
    pub fn restore_request_finalizer_for_handoff(
        &self,
        finalizer: V3RequestFinalizerGuard,
    ) -> Result<(), (V3RequestFinalizerGuard, String)> {
        let mut slot = match self.request_finalizer.lock() {
            Ok(slot) => slot,
            Err(poisoned) => {
                drop(poisoned.into_inner());
                return Err((
                    finalizer,
                    format!(
                        "request {} finalizer slot lock poisoned",
                        self.request_context.request_id()
                    ),
                ));
            }
        };
        if slot.is_some() {
            return Err((
                finalizer,
                format!(
                    "request {} finalizer slot already occupied during handoff",
                    self.request_context.request_id()
                ),
            ));
        }
        *slot = Some(finalizer);
        Ok(())
    }

    pub fn deadline_unix_ms(&self) -> Result<u64, V3AttemptStoreError> {
        let now = Instant::now();
        if now >= self.attempt_budget.inner.deadline {
            return Err(V3AttemptStoreError::LocalResourceExhausted(
                "request execution deadline has expired".to_string(),
            ));
        }
        let remaining = self.attempt_budget.inner.deadline.duration_since(now);
        let now_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| {
                V3AttemptStoreError::InvalidAttemptState(format!(
                    "system clock is before the Unix epoch: {error}"
                ))
            })?
            .as_millis();
        u64::try_from(now_unix_ms)
            .ok()
            .and_then(|now_unix_ms| {
                u64::try_from(remaining.as_millis())
                    .ok()
                    .and_then(|remaining_ms| now_unix_ms.checked_add(remaining_ms))
            })
            .ok_or_else(|| {
                V3AttemptStoreError::InvalidAttemptState(
                    "request execution deadline overflowed Unix milliseconds".to_string(),
                )
            })
    }

    #[cfg(test)]
    pub(crate) fn transport_attempts(&self) -> usize {
        self.attempt_budget.transport_attempts()
    }
}

struct V3AttemptBudgetInner {
    limits: V3AttemptStoreLimits,
    transport_attempt_limit: AtomicUsize,
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
                // Zero means no Target10 candidate plan has been installed;
                // admission then uses the configured request ceiling.
                transport_attempt_limit: AtomicUsize::new(0),
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

    pub(crate) fn residence_deadline(&self) -> Instant {
        self.inner.deadline
    }

    pub(crate) fn admit_transport_attempt(&self) -> Result<usize, V3AttemptStoreError> {
        self.ensure_resident()?;
        let planned_limit = self.inner.transport_attempt_limit.load(Ordering::Acquire);
        let limit = if planned_limit == 0 {
            self.inner.limits.request_max_attempts
        } else {
            planned_limit.min(self.inner.limits.request_max_attempts)
        };
        self.inner
            .transport_attempts
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < limit).then_some(current + 1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| {
                V3AttemptStoreError::LocalResourceExhausted(format!(
                    "request provider transport attempt limit {} exhausted",
                    limit
                ))
            })
    }

    pub(crate) fn set_transport_attempt_limit(&self, candidate_count: usize) {
        self.inner
            .transport_attempt_limit
            .fetch_max(candidate_count.max(1), Ordering::AcqRel);
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

/// Budget-reserving writer for one growth-admitted committed-SSE frame rewrite.
///
/// Bytes are reserved on the shared attempt reservation before they are copied
/// into the frame buffer, so a rewrite that grows a frame cannot materialize
/// output the attempt/request/process ceilings would reject. The first
/// reservation failure is retained as a typed attempt-store error so the
/// builder can return that classification instead of relabelling the caller's
/// own error.
struct V3GrowthRewriteSink<'a> {
    reservation: &'a mut V3AttemptReservation,
    attempt_max_bytes: usize,
    total: usize,
    buffer: Vec<u8>,
    failure: Option<V3AttemptStoreError>,
}

impl V3GrowthRewriteSink<'_> {
    fn record_failure(&mut self, error: V3AttemptStoreError) -> std::io::Error {
        let message = error.to_string();
        if self.failure.is_none() {
            self.failure = Some(error);
        }
        std::io::Error::new(std::io::ErrorKind::Other, message)
    }
}

impl std::io::Write for V3GrowthRewriteSink<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let next_total = match self.total.checked_add(bytes.len()) {
            Some(next_total) => next_total,
            None => {
                return Err(self.record_failure(V3AttemptStoreError::LocalResourceExhausted(
                    "provider SSE attempt byte count overflowed".to_string(),
                )))
            }
        };
        if next_total > self.attempt_max_bytes {
            return Err(self.record_failure(V3AttemptStoreError::LocalResourceExhausted(
                format!(
                    "provider SSE attempt exceeded the committed replay byte limit ({})",
                    self.attempt_max_bytes
                ),
            )));
        }
        if let Err(error) = self.reservation.reserve(bytes.len()) {
            return Err(self.record_failure(error));
        }
        self.buffer.extend_from_slice(bytes);
        self.total = next_total;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
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
                terminal_frame_consumed: false,
            }),
            next_frame_index,
            terminal_frame_index,
        }
    }

    pub fn with_request_finalizer(self, finalizer: Option<V3RequestFinalizerGuard>) -> Self {
        match finalizer {
            Some(finalizer) => self.observe(|_| {}, move |_terminal| drop(finalizer)),
            None => self,
        }
    }
}

struct V3ObservedCommittedSseStream {
    source: V3CommittedClientSseStream,
    on_frame: Box<dyn Fn(&[u8]) + Send + Sync>,
    on_terminal: Option<Box<dyn FnOnce(V3CommittedSseTerminal) + Send>>,
    /// Whether the protocol terminal frame has been yielded to the client.
    /// Drop uses this to preserve Completed versus Dropped semantics.
    terminal_frame_consumed: bool,
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
                    self.terminal_frame_consumed = true;
                }
                // Terminal callbacks run only after EOF or Drop. Running one
                // beside on_frame would let recorders overwrite artifacts
                // before the terminal frame is returned.
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
        let terminal = if self.terminal_frame_consumed {
            V3CommittedSseTerminal::Completed
        } else {
            V3CommittedSseTerminal::Dropped
        };
        self.finish(terminal);
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

    pub(crate) fn rewrite_frames_non_increasing(
        &mut self,
        mut rewrite: impl FnMut(Vec<u8>) -> Vec<u8>,
    ) -> Result<(), V3AttemptStoreError> {
        let old_bytes = self.byte_len;
        let mut new_bytes = 0usize;
        let mut rewritten = Vec::with_capacity(self.frames.len());
        for frame in std::mem::take(&mut self.frames) {
            let frame = rewrite(frame);
            if frame.is_empty() {
                return Err(V3AttemptStoreError::InvalidAttemptState(
                    "committed SSE frame rewrite produced an empty frame".to_string(),
                ));
            }
            new_bytes = new_bytes.checked_add(frame.len()).ok_or_else(|| {
                V3AttemptStoreError::LocalResourceExhausted(
                    "provider SSE attempt byte count overflowed".to_string(),
                )
            })?;
            rewritten.push(frame);
        }
        if new_bytes > old_bytes {
            return Err(V3AttemptStoreError::InvalidAttemptState(
                "committed SSE frame rewrite must not increase byte count".to_string(),
            ));
        }
        self.reservation
            .budget
            .release(old_bytes.saturating_sub(new_bytes));
        self.reservation.bytes = new_bytes;
        self.byte_len = new_bytes;
        self.frames = rewritten;
        Ok(())
    }

    /// Fallible, growth-admitting frame rewrite owned by the same attempt
    /// reservation. Each existing frame is rewritten in order through a
    /// budget-reserving writer, so byte capacity is reserved on the
    /// attempt/request/process budget before any output byte is copied. Frame
    /// order and the terminal frame index are preserved because every input
    /// frame produces exactly one non-empty output frame.
    ///
    /// A failure restores the original frames and releases every byte reserved
    /// for output, so no partial output is committed and no reservation leaks.
    /// On success the previous reservation is released once and the new total
    /// stays reserved until seal or drop.
    pub(crate) fn rewrite_frames_with_growth(
        &mut self,
        mut rewrite: impl FnMut(&[u8], &mut dyn std::io::Write) -> Result<(), V3AttemptStoreError>,
    ) -> Result<(), V3AttemptStoreError> {
        self.reservation.budget.ensure_resident()?;
        let attempt_max_bytes = self.limits.attempt_max_bytes;
        let old_bytes = self.byte_len;
        let frames = std::mem::take(&mut self.frames);
        let mut rewritten: Vec<Vec<u8>> = Vec::with_capacity(frames.len());
        let mut new_total = 0usize;
        let mut outcome: Result<(), V3AttemptStoreError> = Ok(());
        for frame in &frames {
            let mut sink = V3GrowthRewriteSink {
                reservation: &mut self.reservation,
                attempt_max_bytes,
                total: new_total,
                buffer: Vec::new(),
                failure: None,
            };
            let rewrite_result = rewrite(frame.as_slice(), &mut sink);
            let failure = sink.failure.take();
            new_total = sink.total;
            let buffer = std::mem::take(&mut sink.buffer);
            drop(sink);
            if let Some(error) = failure {
                outcome = Err(error);
                break;
            }
            match rewrite_result {
                Ok(()) if !buffer.is_empty() => rewritten.push(buffer),
                Ok(()) => {
                    outcome = Err(V3AttemptStoreError::InvalidAttemptState(
                        "committed SSE frame rewrite produced an empty frame".to_string(),
                    ));
                    break;
                }
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            }
        }
        match outcome {
            Ok(()) => {
                self.reservation.budget.release(old_bytes);
                self.reservation.bytes = new_total;
                self.byte_len = new_total;
                self.frames = rewritten;
                Ok(())
            }
            Err(error) => {
                self.reservation.budget.release(new_total);
                self.reservation.bytes = old_bytes;
                self.frames = frames;
                Err(error)
            }
        }
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
