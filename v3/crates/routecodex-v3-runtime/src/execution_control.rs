use futures_util::Stream;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
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
pub enum V3AttemptStoreError {
    ResidenceDeadlineExceeded(String),
    LocalResourceExhausted(String),
    InvalidAttemptState(String),
    /// The complete-attempt text governance must decide a committed tail, but
    /// the registered owner refused to project it as business content. The
    /// transport ends detectably without projecting further frames.
    PostCommitGovernedTail(String),
}

impl fmt::Display for V3AttemptStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ResidenceDeadlineExceeded(message)
            | Self::LocalResourceExhausted(message)
            | Self::InvalidAttemptState(message)
            | Self::PostCommitGovernedTail(message) => formatter.write_str(message),
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

    pub fn refill_used(&self) -> u32 {
        self.attempt_budget
            .inner
            .refill_used
            .load(Ordering::Acquire)
    }

    /// Consume one refill execution slot. Returns true only when a slot was
    /// available (used < max) and was incremented atomically.
    pub(crate) fn try_admit_refill(&self, max_consecutive_refills: u32) -> bool {
        if max_consecutive_refills == 0 {
            return false;
        }
        self.attempt_budget
            .inner
            .refill_used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < max_consecutive_refills).then_some(current + 1)
            })
            .is_ok()
    }

    /// Open one more execution of the same request.
    ///
    /// A bounded refill is a new execution of the Runtime mainline, so it owns
    /// its own provider transport attempt allowance; the request-scoped refill
    /// budget, residence deadline and resident-byte accounting stay unchanged.
    pub(crate) fn begin_refill_execution(&self) {
        self.attempt_budget
            .inner
            .transport_attempts
            .store(0, Ordering::Release);
        self.attempt_budget
            .inner
            .transport_attempt_limit
            .store(0, Ordering::Release);
    }

    pub fn deadline_unix_ms(&self) -> Result<u64, V3AttemptStoreError> {
        let now = Instant::now();
        if now >= self.attempt_budget.inner.deadline {
            return Err(V3AttemptStoreError::ResidenceDeadlineExceeded(
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
    refill_used: AtomicU32,
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
                refill_used: AtomicU32::new(0),
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
            return Err(V3AttemptStoreError::ResidenceDeadlineExceeded(
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

/// Runtime-sealed replay of one completely validated provider attempt.
///
/// The inner stream and constructor are intentionally private. Server/Front
/// code may consume or observe the replay, but cannot manufacture an empty or
/// terminal-incomplete stream and call it committed.
pub struct V3CommittedClientSseStream {
    inner: Pin<Box<dyn Stream<Item = Vec<u8>> + Send>>,
    next_frame_index: usize,
    terminal_frame_index: usize,
    /// Number of committed frames already handed to the client channel before
    /// sealing. The sealed replay only carries the remainder, so this prefix
    /// count lets the Direct refill assembly avoid re-emitting content the
    /// client already received.
    flushed_prefix_frames: usize,
    /// Complete committed business result of the sealed attempt, shared with
    /// the replay iterator instead of copied. Chat Process governance reads it
    /// to decide bounded refill from the governed result; the client stream
    /// keeps replaying exactly the same frames.
    sealed_frames: Option<std::sync::Arc<Vec<Vec<u8>>>>,
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
    frames: std::sync::Arc<Vec<Vec<u8>>>,
    next: usize,
    _reservation: V3AttemptReservation,
}

impl Stream for V3ReservedCommittedSseReplay {
    type Item = Vec<u8>;

    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let item = self.frames.get(self.next).cloned();
        if item.is_some() {
            self.next += 1;
        }
        Poll::Ready(item)
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
        let flushed_prefix_frames = self.flushed_prefix_frames;
        let sealed_frames = self.sealed_frames.clone();
        Self {
            inner: Box::pin(V3ObservedCommittedSseStream {
                source: self,
                on_frame: Box::new(on_frame),
                on_terminal: Some(Box::new(on_terminal)),
                terminal_frame_consumed: false,
            }),
            next_frame_index,
            terminal_frame_index,
            flushed_prefix_frames,
            sealed_frames,
        }
    }

    /// Number of committed frames already delivered to the client before the
    /// sealed stream was produced. Zero means the attempt was fully buffered.
    pub(crate) fn flushed_prefix_frames(&self) -> usize {
        self.flushed_prefix_frames
    }

    /// Every committed business frame of the sealed attempt, in order.
    ///
    /// The sealed stream only replays frames that were not already handed to
    /// the client, so the intermediate refill decision cannot read the
    /// delivered remainder and call it the complete result. This accessor
    /// exposes the whole committed attempt that the seal validated.
    pub(crate) fn sealed_frames(&self) -> std::sync::Arc<Vec<Vec<u8>>> {
        self.sealed_frames
            .clone()
            .unwrap_or_else(|| std::sync::Arc::new(Vec::new()))
    }
}

struct V3ObservedCommittedSseStream {
    source: V3CommittedClientSseStream,
    on_frame: V3CommittedSseFrameObserver,
    on_terminal: Option<V3CommittedSseTerminalObserver>,
    /// Whether the protocol terminal frame has been yielded to the client.
    /// Drop uses this to preserve Completed versus Dropped semantics.
    terminal_frame_consumed: bool,
}

type V3CommittedSseFrameObserver = Box<dyn Fn(&[u8]) + Send + Sync>;
type V3CommittedSseTerminalObserver = Box<dyn FnOnce(V3CommittedSseTerminal) + Send>;

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
    /// Frames already handed to the client channel after the first business
    /// frame committed the attempt. Zero means the attempt is still fully
    /// buffered, which is the only state that may run a whole-attempt rewrite.
    flushed_frames: usize,
    client_sink: Option<V3CommittedClientFrameSink>,
    /// Suspends live projection while the newest committed text may still be
    /// governed. `push` keeps appending to `frames` but does not hand them to
    /// the sink, so the complete-attempt hook can still decide them.
    flush_held: bool,
}

/// Runtime-owned sink for client frames that already crossed the commit point.
///
/// The server transport consumes the paired receiver; a dropped receiver means
/// the client transport is gone, so a send failure is not a runtime failure.
#[derive(Clone)]
pub struct V3CommittedClientFrameSink {
    sender: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    committed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Request-wide offset applied to each frame's round-local `output_index`
    /// just before the frame reaches the client channel. The Direct refill
    /// loop supplies the number of business items already delivered by earlier
    /// rounds so two executions never both address index 0.
    output_index_offset: usize,
}

impl V3CommittedClientFrameSink {
    pub fn channel() -> (Self, tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Self {
                sender,
                committed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                output_index_offset: 0,
            },
            receiver,
        )
    }

    /// Return a sink that shifts each committed frame's `output_index` by
    /// `offset` before sending. The committed marker stays shared with the
    /// original sink, so the commit point is still request-wide.
    pub(crate) fn with_output_index_offset(mut self, offset: usize) -> Self {
        self.output_index_offset = offset;
        self
    }

    /// True once the attempt crossed the client commit point. A committed
    /// attempt can never be retracted or replaced by another candidate.
    pub fn is_committed(&self) -> bool {
        self.committed.load(std::sync::atomic::Ordering::Acquire)
    }

    fn mark_committed(&self) {
        self.committed
            .store(true, std::sync::atomic::Ordering::Release);
    }

    fn send(&self, frame: Vec<u8>) {
        let frame = if self.output_index_offset == 0 {
            frame
        } else {
            crate::kernel::shift_direct_sse_output_index(&frame, self.output_index_offset)
        };
        let _ = self.sender.send(frame);
    }

    /// Send a frame whose `output_index` is already request-wide.
    ///
    /// A refill round's governed remainder is prepared by the runtime before a
    /// later round may emit live frames, so the round-local offset must not be
    /// applied a second time. Reaching the client now is what keeps the
    /// request-level event order intact: the next round can commit its first
    /// business frame as soon as it exists, and a remainder held back would
    /// then arrive after it.
    pub(crate) fn send_prepared(&self, frame: Vec<u8>) {
        let _ = self.sender.send(frame);
    }
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
            flushed_frames: 0,
            client_sink: None,
            flush_held: false,
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
        self.flush_client_frames();
        Ok(())
    }

    /// Commit the attempt to the client channel: every frame pushed from now on
    /// is handed to `sink` as soon as it exists. Callers must prove that no
    /// whole-attempt rewrite can rewrite or replace an already-flushed frame.
    pub(crate) fn commit_client_stream(&mut self, sink: V3CommittedClientFrameSink) {
        sink.mark_committed();
        self.client_sink = Some(sink);
        self.flush_client_frames();
    }

    /// Flushed frame count, used by the builder's own tests to prove that a
    /// hold keeps frames buffered while projection is suspended.
    #[cfg(test)]
    pub(crate) fn client_frames_flushed(&self) -> usize {
        self.flushed_frames
    }

    /// Stop projecting new frames while provider text may still be governed.
    /// The frames keep accumulating in the attempt, so the registered
    /// complete-attempt hook still sees and may rewrite them. Nothing that was
    /// already flushed is affected.
    pub(crate) fn hold_client_flush(&mut self) {
        self.flush_held = true;
    }

    /// Resume projection. The registered hook (or the attempt's own decision not
    /// to run one) has already disposed of the held frames, so they are handed
    /// to the sink in order.
    pub(crate) fn release_client_flush(&mut self) {
        self.flush_held = false;
        self.flush_client_frames();
    }

    pub(crate) fn flush_client_frames(&mut self) {
        if self.flush_held {
            return;
        }
        let Some(sink) = self.client_sink.as_ref() else {
            return;
        };
        while self.flushed_frames < self.frames.len() {
            let frame = self.frames[self.flushed_frames].clone();
            sink.send(frame);
            self.flushed_frames += 1;
        }
    }

    fn ensure_fully_buffered(&self, owner: &str) -> Result<(), V3AttemptStoreError> {
        if self.flushed_frames == 0 {
            return Ok(());
        }
        Err(V3AttemptStoreError::InvalidAttemptState(format!(
            "{owner} cannot run after {} client frames were already flushed",
            self.flushed_frames
        )))
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
        self.ensure_fully_buffered("committed SSE frame rewrite")?;
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

    /// Whole-attempt response hooks run before sealing and remain inside the
    /// same reservation, frame limit and byte limit as the original attempt.
    pub(crate) fn rewrite_complete_attempt<E>(
        &mut self,
        rewrite: impl FnOnce(&[Vec<u8>]) -> Result<Option<(Vec<Vec<u8>>, usize)>, E>,
    ) -> Result<(), E>
    where
        E: From<V3AttemptStoreError>,
    {
        self.ensure_fully_buffered("whole-attempt response hook")?;
        let Some((frames, terminal)) = rewrite(&self.frames)? else {
            return Ok(());
        };
        self.adopt_rewritten_attempt(frames, terminal)
    }

    /// Whole-attempt response hook invocation that is also allowed after the
    /// client commit point, provided the registered governance leaves every
    /// already-flushed client frame byte-identical. Callers use it to keep the
    /// complete-attempt text governance on the first-frame-commit path instead
    /// of skipping it. A rewrite that would change a flushed frame cannot be
    /// retracted, so it is rejected with [`V3AttemptStoreError::PostCommitGovernedTail`]
    /// and the caller terminates the committed transport without projecting
    /// new frames.
    pub(crate) fn rewrite_complete_attempt_preserving_client_prefix<E>(
        &mut self,
        rewrite: impl FnOnce(&[Vec<u8>], usize) -> Result<Option<(Vec<Vec<u8>>, usize)>, E>,
    ) -> Result<(), E>
    where
        E: From<V3AttemptStoreError>,
    {
        let flushed = self.flushed_frames;
        let flushed_frames = self.frames[..flushed].to_vec();
        let Some((frames, terminal)) = rewrite(&self.frames, flushed)? else {
            return Ok(());
        };
        if frames.len() < flushed || frames[..flushed] != flushed_frames[..] {
            return Err(V3AttemptStoreError::PostCommitGovernedTail(format!(
                "whole-attempt response hook would rewrite {flushed} client frames that were already flushed"
            ))
            .into());
        }
        self.adopt_rewritten_attempt(frames, terminal)
    }

    fn adopt_rewritten_attempt<E>(&mut self, frames: Vec<Vec<u8>>, terminal: usize) -> Result<(), E>
    where
        E: From<V3AttemptStoreError>,
    {
        let bytes = frames
            .iter()
            .try_fold(0usize, |n, f| n.checked_add(f.len()))
            .ok_or_else(|| {
                V3AttemptStoreError::LocalResourceExhausted(
                    "rewritten attempt byte count overflowed".into(),
                )
            })?;
        if frames.len() > self.limits.attempt_max_frames || bytes > self.limits.attempt_max_bytes {
            return Err(V3AttemptStoreError::LocalResourceExhausted(
                "rewritten attempt exceeds configured limits".into(),
            )
            .into());
        }
        if terminal >= frames.len() || frames.iter().any(Vec::is_empty) {
            return Err(V3AttemptStoreError::InvalidAttemptState(
                "rewritten attempt requires nonempty frames and a terminal".into(),
            )
            .into());
        }
        if bytes > self.byte_len {
            self.reservation
                .reserve(bytes - self.byte_len)
                .map_err(E::from)?;
        } else {
            self.reservation.budget.release(self.byte_len - bytes);
            self.reservation.bytes = bytes;
        }
        self.byte_len = bytes;
        self.frames = frames;
        self.terminal_frame_index = Some(terminal);
        Ok(())
    }

    pub(crate) fn frames(&self) -> &[Vec<u8>] {
        &self.frames
    }

    pub(crate) fn last_marked_terminal_frame_index(&self) -> Option<usize> {
        self.terminal_frame_index
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
        // The sealed stream replays only the held remainder. Its frame indices
        // therefore start at zero, and the terminal index shares that
        // remainder-relative coordinate system after subtracting the prefix
        // already handed to the client.
        let relative_terminal_frame_index =
            terminal_frame_index.saturating_sub(self.flushed_frames);
        let sealed_frames = std::sync::Arc::new(self.frames);
        let replay_frames = std::sync::Arc::clone(&sealed_frames);
        Ok(V3CommittedClientSseStream {
            inner: Box::pin(V3ReservedCommittedSseReplay {
                frames: replay_frames,
                next: self.flushed_frames,
                _reservation: self.reservation,
            }),
            next_frame_index: 0,
            terminal_frame_index: relative_terminal_frame_index,
            flushed_prefix_frames: self.flushed_frames,
            sealed_frames: Some(sealed_frames),
        })
    }
}

#[cfg(test)]
mod tests;
