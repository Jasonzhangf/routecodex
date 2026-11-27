use futures_util::Stream;
use std::collections::BTreeSet;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use routecodex_v3_provider_responses::{
    V3ProviderBusinessRecoveryAcquisition, V3ProviderHealthProbePermit, V3ProviderHealthStore,
};

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
    pub(crate) attempt_max_bytes: usize,
    pub(crate) attempt_max_frames: usize,
    pub(crate) request_max_bytes: usize,
    pub(crate) process_max_bytes: usize,
    pub(crate) residence_timeout: Duration,
}

impl Default for V3AttemptStoreLimits {
    fn default() -> Self {
        Self {
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

/// Opaque request execution control carried across handoffs and refills.
/// The server moves this value without reading its attempt budget or failed
/// Provider identities from protocol payloads.
#[derive(Clone)]
pub struct V3RequestExecutionControl {
    attempt_budget: V3AttemptBudget,
    refill_excluded_candidates: Arc<Mutex<BTreeSet<String>>>,
    business_recovery_trial: Arc<Mutex<Option<V3BusinessRecoveryTrialGuard>>>,
    compaction_generation: Arc<std::sync::OnceLock<u64>>,
    pub(crate) image_history: Option<crate::image_history::V3ImageHistoryView>,
}

struct V3BusinessRecoveryTrialGuard {
    store: V3ProviderHealthStore,
    permit: V3ProviderHealthProbePermit,
}

impl Drop for V3BusinessRecoveryTrialGuard {
    fn drop(&mut self) {
        let _ = self.store.cancel_provider_cooldown_probe(&self.permit);
    }
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
            refill_excluded_candidates: Arc::default(),
            business_recovery_trial: Arc::new(Mutex::new(None)),
            compaction_generation: Arc::default(),
            image_history: None,
        })
    }

    pub(crate) fn retain_compaction_generation(&self, observed: Option<u64>) -> Option<u64> {
        observed.map(|generation| *self.compaction_generation.get_or_init(|| generation))
    }

    pub(crate) fn acquire_business_recovery_trial(
        &self,
        store: &V3ProviderHealthStore,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<bool, V3AttemptStoreError> {
        let acquisition = store
            .acquire_provider_business_recovery_trial_for_interface(
                provider_id,
                interface_id,
                Some(auth_alias),
                Some(model_id),
                now_ms,
            )
            .map_err(|error| {
                V3AttemptStoreError::InvalidAttemptState(format!(
                    "business recovery acquisition failed: {error}"
                ))
            })?;
        match acquisition {
            V3ProviderBusinessRecoveryAcquisition::NotRequired => Ok(true),
            V3ProviderBusinessRecoveryAcquisition::Contended => Ok(false),
            V3ProviderBusinessRecoveryAcquisition::Acquired(permit) => {
                let guard = V3BusinessRecoveryTrialGuard {
                    store: store.clone(),
                    permit,
                };
                let mut trial = self.business_recovery_trial.lock().map_err(|_| {
                    V3AttemptStoreError::InvalidAttemptState(
                        "business recovery ownership is unavailable".into(),
                    )
                })?;
                if trial.is_some() {
                    return Err(V3AttemptStoreError::InvalidAttemptState(
                        "business recovery ownership was already installed for this request".into(),
                    ));
                }
                *trial = Some(guard);
                Ok(true)
            }
        }
    }

    pub(crate) fn settle_business_recovery_success(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<Option<bool>, V3AttemptStoreError> {
        let trial = self.take_matching_business_recovery_trial(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        )?;
        let Some(trial) = trial else {
            return Ok(None);
        };
        let recovered = trial
            .store
            .complete_provider_business_recovery_success_with_permit(&trial.permit, now_ms)
            .map_err(|error| V3AttemptStoreError::InvalidAttemptState(error.to_string()))?;
        // false means the permit no longer identifies the current episode.
        // Keep it distinct from None so the caller does not treat a stale
        // recovery attempt as an ordinary successful business attempt.
        Ok(Some(recovered))
    }

    pub(crate) fn settle_business_recovery_failure(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
        has_alternative: bool,
    ) -> Result<bool, V3AttemptStoreError> {
        let trial = self.take_matching_business_recovery_trial(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
        )?;
        let Some(trial) = trial else {
            return Ok(false);
        };
        if has_alternative {
            trial
                .store
                .complete_provider_cooldown_probe_failure_with_permit(&trial.permit, now_ms)
                .map_err(|error| V3AttemptStoreError::InvalidAttemptState(error.to_string()))?;
        } else {
            // Terminal failures release custody without penalizing the identity.
            trial
                .store
                .cancel_provider_cooldown_probe(&trial.permit)
                .map_err(|error| V3AttemptStoreError::InvalidAttemptState(error.to_string()))?;
        }
        Ok(true)
    }

    fn take_matching_business_recovery_trial(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
    ) -> Result<Option<V3BusinessRecoveryTrialGuard>, V3AttemptStoreError> {
        let mut trial = self.business_recovery_trial.lock().map_err(|_| {
            V3AttemptStoreError::InvalidAttemptState(
                "business recovery ownership is unavailable".into(),
            )
        })?;
        let matches = trial.as_ref().is_some_and(|trial| {
            trial.permit.provider_id() == provider_id
                && trial.permit.interface_id() == interface_id
                && trial.permit.auth_alias() == Some(auth_alias)
                && trial.permit.model_id() == Some(model_id)
        });
        Ok(if matches { trial.take() } else { None })
    }

    pub fn with_image_history(mut self, image_history: Option<crate::V3ImageHistoryView>) -> Self {
        self.image_history = image_history;
        self
    }

    pub(crate) fn take_refill_excluded_candidates(
        &self,
    ) -> Result<BTreeSet<String>, V3AttemptStoreError> {
        let mut candidates = self.refill_excluded_candidates.lock().map_err(|_| {
            V3AttemptStoreError::InvalidAttemptState("refill candidate state is unavailable".into())
        })?;
        Ok(std::mem::take(&mut *candidates))
    }

    pub(crate) fn store_refill_excluded_candidates(
        &self,
        candidates: BTreeSet<String>,
    ) -> Result<(), V3AttemptStoreError> {
        *self.refill_excluded_candidates.lock().map_err(|_| {
            V3AttemptStoreError::InvalidAttemptState("refill candidate state is unavailable".into())
        })? = candidates;
        Ok(())
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
    /// its own diagnostic transport attempt count; the request-scoped refill
    /// budget, residence deadline and resident-byte accounting stay unchanged.
    pub(crate) fn begin_refill_execution(&self) {
        self.attempt_budget
            .inner
            .transport_attempts
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
                // Zero means no Target10 candidate plan has been installed.
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

    pub(crate) fn residence_deadline(&self) -> Instant {
        self.inner.deadline
    }
    pub(crate) fn admit_transport_attempt(&self) -> Result<usize, V3AttemptStoreError> {
        let previous = self
            .inner
            .transport_attempts
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current.checked_add(1)
            })
            .map_err(|_| {
                V3AttemptStoreError::InvalidAttemptState(
                    "request provider transport attempt count overflowed".to_string(),
                )
            })?;
        Ok(previous + 1)
    }

    pub(crate) fn transport_attempts(&self) -> usize {
        self.inner.transport_attempts.load(Ordering::Acquire)
    }

    pub(crate) fn reserve_payload(&self) -> V3AttemptReservation {
        V3AttemptReservation {
            budget: self.clone(),
            bytes: 0,
        }
    }

    fn reserve(&self, bytes: usize) -> Result<(), V3AttemptStoreError> {
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

pub(crate) struct V3AttemptReservation {
    budget: V3AttemptBudget,
    bytes: usize,
}

impl V3AttemptReservation {
    pub(crate) fn reserve_frame(
        &mut self,
        frames_already_reserved: usize,
        bytes: usize,
    ) -> Result<(), V3AttemptStoreError> {
        let limits = self.budget.inner.limits;
        if frames_already_reserved >= limits.attempt_max_frames {
            return Err(V3AttemptStoreError::LocalResourceExhausted(format!(
                "provider SSE attempt exceeded its frame limit ({})",
                limits.attempt_max_frames
            )));
        }
        if bytes > limits.attempt_max_bytes.saturating_sub(self.bytes) {
            return Err(V3AttemptStoreError::LocalResourceExhausted(format!(
                "provider SSE attempt exceeded its byte limit ({})",
                limits.attempt_max_bytes
            )));
        }
        self.reserve(bytes)
    }

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
            sealed_frames,
        }
    }

    /// Every committed business frame of the sealed attempt, in order.
    ///
    pub(crate) fn sealed_frames(&self) -> std::sync::Arc<Vec<Vec<u8>>> {
        self.sealed_frames
            .clone()
            .unwrap_or_else(|| std::sync::Arc::new(Vec::new()))
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
        self.reservation
            .reserve_frame(self.frames.len(), frame.len())?;
        self.byte_len += frame.len();
        self.frames.push(frame);
        Ok(())
    }

    fn ensure_fully_buffered(&self, owner: &str) -> Result<(), V3AttemptStoreError> {
        let _ = owner;
        Ok(())
    }

    pub(crate) fn mark_last_frame_as_terminal(&mut self) -> Result<(), V3AttemptStoreError> {
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
        let sealed_frames = std::sync::Arc::new(self.frames);
        let replay_frames = std::sync::Arc::clone(&sealed_frames);
        Ok(V3CommittedClientSseStream {
            inner: Box::pin(V3ReservedCommittedSseReplay {
                frames: replay_frames,
                next: 0,
                _reservation: self.reservation,
            }),
            next_frame_index: 0,
            terminal_frame_index,
            sealed_frames: Some(sealed_frames),
        })
    }
}

#[cfg(test)]
mod tests;
