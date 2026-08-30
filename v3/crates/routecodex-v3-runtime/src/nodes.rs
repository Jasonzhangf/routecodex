use futures_util::Stream;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_route_classifier::{
    build_v3_current_turn_route_facts_from_value, classify_route, V3CurrentTurnRouteFacts,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
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

#[derive(Debug, Clone, PartialEq)]
pub struct V3Server03HttpRequestRaw {
    pub server_id: String,
    /// Listener port is a control-plane scope component. It is optional on
    /// legacy/unit construction paths and must be present before restart
    /// handoff is admitted; no owner may infer it from server_id or payload.
    pub port: Option<u16>,
    /// Request ingress pipeline identity. Missing legacy/unit scope remains
    /// explicit and cannot be reconstructed from execution_id or payload.
    pub pipeline_id: Option<String>,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub method: String,
    pub path: String,
    pub request_purpose: V3RequestPurpose,
    pub body: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3RequestPurpose {
    Conversation,
    AuxiliaryCompaction,
    NativeCompaction,
}

impl V3RequestPurpose {
    pub fn is_compaction(self) -> bool {
        matches!(self, Self::AuxiliaryCompaction | Self::NativeCompaction)
    }
}

pub fn build_v3_server_03_http_request_raw(
    server_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    body: Value,
) -> V3Server03HttpRequestRaw {
    build_v3_server_03_http_request_raw_with_purpose(
        server_id,
        failure_session_scope,
        request_id,
        execution_id,
        method,
        path,
        V3RequestPurpose::Conversation,
        body,
    )
}

pub fn build_v3_server_03_http_request_raw_with_purpose(
    server_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    request_purpose: V3RequestPurpose,
    body: Value,
) -> V3Server03HttpRequestRaw {
    build_v3_server_03_http_request_raw_with_purpose_and_scope(
        server_id,
        failure_session_scope,
        request_id,
        execution_id,
        method,
        path,
        request_purpose,
        None,
        None,
        body,
    )
}

pub fn build_v3_server_03_http_request_raw_with_purpose_and_port(
    server_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    request_purpose: V3RequestPurpose,
    port: Option<u16>,
    body: Value,
) -> V3Server03HttpRequestRaw {
    build_v3_server_03_http_request_raw_with_purpose_and_scope(
        server_id,
        failure_session_scope,
        request_id,
        execution_id,
        method,
        path,
        request_purpose,
        port,
        None,
        body,
    )
}

pub fn build_v3_server_03_http_request_raw_with_purpose_and_scope(
    server_id: String,
    failure_session_scope: V3ProviderFailureSessionScope,
    request_id: String,
    execution_id: String,
    method: String,
    path: String,
    request_purpose: V3RequestPurpose,
    port: Option<u16>,
    pipeline_id: Option<String>,
    body: Value,
) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        server_id,
        port,
        pipeline_id,
        failure_session_scope,
        request_id,
        execution_id,
        method,
        path,
        request_purpose,
        body,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedResponses {
    pub body: Value,
    pub server_id: String,
    pub port: Option<u16>,
    pub pipeline_id: Option<String>,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub endpoint: String,
    pub method: String,
    pub request_purpose: V3RequestPurpose,
    pub tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext,
}

/// Chat 入口标准化（与 V3Req04StandardizedResponses 同构，协议不同）：
/// 校验 chat 协议必需字段（messages），应用唯一登记的历史图片占位清理，
/// 不携带 continuation locator（chat 无 previous_response_id）。
#[derive(Debug, Clone, PartialEq)]
pub struct V3Req04StandardizedChat {
    pub body: Value,
    pub server_id: String,
    pub port: Option<u16>,
    pub pipeline_id: Option<String>,
    pub failure_session_scope: V3ProviderFailureSessionScope,
    pub request_id: String,
    pub execution_id: String,
    pub endpoint: String,
    pub method: String,
    pub request_purpose: V3RequestPurpose,
    pub tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext,
}

/// Chat direct 执行策略节点（与 V3ResponsesDirect11Policy 同构）。
#[derive(Debug, Clone, PartialEq)]
pub struct V3ChatDirect11Policy {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
}

pub fn build_v3_chat_direct_11_policy_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    standardized: &V3Req04StandardizedChat,
) -> V3ChatDirect11Policy {
    V3ChatDirect11Policy {
        target: selected,
        request_id: standardized.request_id.clone(),
        request_body: standardized.body.clone(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct V3ResponsesDirect11Policy {
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    pub request_id: String,
    pub request_body: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3Execution11ProtocolDecisionMode {
    SameProtocolDirect,
    HubRelay,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Execution11ProtocolDecision {
    pub mode: V3Execution11ProtocolDecisionMode,
    pub entry_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    pub selected_provider_protocol: crate::hub_v1::V3HubProviderWireProtocol,
    pub target: routecodex_v3_target::V3Target10ConcreteProviderSelected,
}

pub type V3ClientSseStream =
    Pin<Box<dyn Stream<Item = Result<Vec<u8>, V3Error01SourceRaised>> + Send>>;
pub(crate) struct V3ProviderAttemptSseStream {
    inner: V3ClientSseStream,
}

impl V3ProviderAttemptSseStream {
    pub(crate) fn new(inner: V3ClientSseStream) -> Self {
        Self { inner }
    }
}

impl Stream for V3ProviderAttemptSseStream {
    type Item = Result<Vec<u8>, V3Error01SourceRaised>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}

impl fmt::Debug for V3ProviderAttemptSseStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("V3ProviderAttemptSseStream(<provider-attempt>)")
    }
}

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
        let policy = server.execution.as_ref().map(|execution| &execution.attempt_store).ok_or_else(
            || {
                V3AttemptStoreError::InvalidAttemptState(format!(
                    "hub_v1 server {server_id} is missing compiled attempt-store policy"
                ))
            },
        )?;
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
    fn new_isolated(limits: V3AttemptStoreLimits, process_resident_bytes: Arc<AtomicUsize>) -> Self {
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
            current
                .checked_add(bytes)
                .filter(|next| *next <= limit)
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

    pub(crate) fn with_budget(
        budget: V3AttemptBudget,
    ) -> Result<Self, V3AttemptStoreError> {
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

    pub(crate) fn mark_last_frame_as_terminal(
        &mut self,
    ) -> Result<(), V3AttemptStoreError> {
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
mod committed_sse_handoff_tests {
    use super::*;
    use futures_util::StreamExt;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use std::sync::{Arc, Mutex};

    fn test_limits(
        attempt_max_bytes: usize,
        request_max_bytes: usize,
        process_max_bytes: usize,
    ) -> V3AttemptStoreLimits {
        V3AttemptStoreLimits {
            request_max_attempts: 3,
            attempt_max_bytes,
            attempt_max_frames: 3,
            request_max_bytes,
            process_max_bytes,
            residence_timeout: std::time::Duration::from_secs(60),
        }
    }

    #[test]
    fn attempt_budget_counts_all_transport_attempts_without_reset() {
        let process_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let budget = V3AttemptBudget::new_isolated(
            test_limits(8, 8, 8),
            Arc::clone(&process_bytes),
        );

        assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
        assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
        assert_eq!(budget.admit_transport_attempt().unwrap(), 3);
        assert!(matches!(
            budget.admit_transport_attempt(),
            Err(V3AttemptStoreError::LocalResourceExhausted(_))
        ));
        assert_eq!(budget.transport_attempts(), 3);
        assert_eq!(process_bytes.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[test]
    fn attempt_budget_consumes_compiled_server_policy() {
        let manifest = compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[pipelines.hub_v1]
skeleton = "hub_v1"
[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
attempt_store = { attempt_max_bytes = 11, attempt_max_frames = 12, request_max_bytes = 13, process_max_bytes = 14, residence_timeout_ms = 15 }
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEST_KEY" }] }
[providers.test.models.test-model]
capabilities = ["text"]
[route_groups.default.pools.default]
targets = [{ kind = "provider_model", provider = "test", model = "test-model", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap();

        let budget = V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
        assert_eq!(budget.inner.limits.attempt_max_bytes, 11);
        assert_eq!(budget.inner.limits.attempt_max_frames, 12);
        assert_eq!(budget.inner.limits.request_max_bytes, 13);
        assert_eq!(budget.inner.limits.process_max_bytes, 14);
        assert_eq!(budget.inner.limits.residence_timeout, Duration::from_millis(15));
        assert!(matches!(
            V3AttemptBudget::from_manifest(&manifest, "missing"),
            Err(V3AttemptStoreError::InvalidAttemptState(_))
        ));
    }

    #[test]
    fn attempt_store_reserves_before_append_and_releases_on_drop() {
        let process_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let budget = V3AttemptBudget::new_isolated(
            test_limits(4, 4, 4),
            Arc::clone(&process_bytes),
        );
        let mut builder = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
        builder.push(vec![1, 2, 3, 4]).unwrap();
        assert_eq!(budget.request_resident_bytes(), 4);
        assert_eq!(process_bytes.load(std::sync::atomic::Ordering::Acquire), 4);
        let error = builder.push(vec![5]).unwrap_err();
        assert!(matches!(
            error,
            V3AttemptStoreError::LocalResourceExhausted(_)
        ));
        assert_eq!(budget.request_resident_bytes(), 4);
        assert_eq!(process_bytes.load(std::sync::atomic::Ordering::Acquire), 4);
        drop(builder);
        assert_eq!(budget.request_resident_bytes(), 0);
        assert_eq!(process_bytes.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[test]
    fn attempt_store_process_budget_is_shared_across_requests() {
        let process_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first_budget = V3AttemptBudget::new_isolated(
            test_limits(8, 8, 6),
            Arc::clone(&process_bytes),
        );
        let second_budget = V3AttemptBudget::new_isolated(
            test_limits(8, 8, 6),
            Arc::clone(&process_bytes),
        );
        let mut first = V3CommittedClientSseBuilder::with_budget(first_budget).unwrap();
        first.push(vec![1, 2, 3, 4]).unwrap();
        let mut second = V3CommittedClientSseBuilder::with_budget(second_budget).unwrap();
        let error = second.push(vec![5, 6, 7]).unwrap_err();
        assert!(matches!(
            error,
            V3AttemptStoreError::LocalResourceExhausted(_)
        ));
        assert_eq!(process_bytes.load(std::sync::atomic::Ordering::Acquire), 4);
    }

    #[test]
    fn attempt_store_request_budget_is_shared_across_attempts() {
        let process_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let budget = V3AttemptBudget::new_isolated(
            test_limits(8, 6, 16),
            Arc::clone(&process_bytes),
        );
        let mut first = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
        first.push(vec![1, 2, 3, 4]).unwrap();
        let mut second = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
        let error = second.push(vec![5, 6, 7]).unwrap_err();
        assert!(matches!(
            error,
            V3AttemptStoreError::LocalResourceExhausted(_)
        ));
        drop(first);
        second.push(vec![5, 6, 7]).unwrap();
        assert_eq!(budget.request_resident_bytes(), 3);
    }

    #[test]
    fn attempt_store_rejects_expired_request_before_reservation() {
        let process_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut limits = test_limits(8, 8, 8);
        limits.residence_timeout = std::time::Duration::ZERO;
        let budget = V3AttemptBudget::new_isolated(limits, Arc::clone(&process_bytes));
        let error = match V3CommittedClientSseBuilder::with_budget(budget) {
            Ok(_) => panic!("expired request budget must reject a new attempt store"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            V3AttemptStoreError::LocalResourceExhausted(_)
        ));
        assert_eq!(process_bytes.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[test]
    fn sealed_replay_holds_reservation_until_stream_drop() {
        let process_bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let budget = V3AttemptBudget::new_isolated(
            test_limits(8, 8, 8),
            Arc::clone(&process_bytes),
        );
        let mut builder = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
        builder.push(vec![1, 2, 3]).unwrap();
        builder.mark_last_frame_as_terminal().unwrap();
        let stream = builder.seal_after_validated_terminal().unwrap();
        assert_eq!(budget.request_resident_bytes(), 3);
        drop(stream);
        assert_eq!(budget.request_resident_bytes(), 0);
        assert_eq!(process_bytes.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    async fn observed_terminal_after_drop(frames_to_consume: usize) -> V3CommittedSseTerminal {
        let mut builder = V3CommittedClientSseBuilder::new();
        builder
            .push(b"event: response.created\n\n".to_vec())
            .unwrap();
        builder
            .push(b"event: response.completed\n\n".to_vec())
            .unwrap();
        builder.mark_last_frame_as_terminal().unwrap();
        builder.push(b"event: ping\n\n".to_vec()).unwrap();
        let terminal = Arc::new(Mutex::new(None));
        let observed_terminal = Arc::clone(&terminal);
        let mut stream = builder.seal_after_validated_terminal().unwrap().observe(
            |_| {},
            move |value| {
                *observed_terminal.lock().unwrap() = Some(value);
            },
        );
        for _ in 0..frames_to_consume {
            stream.next().await.expect("sealed replay frame");
        }
        drop(stream);
        let terminal = terminal
            .lock()
            .unwrap()
            .expect("drop must finalize the committed handoff");
        terminal
    }

    #[tokio::test]
    async fn committed_sse_drop_before_last_handoff_frame_remains_dropped() {
        assert_eq!(
            observed_terminal_after_drop(1).await,
            V3CommittedSseTerminal::Dropped
        );
    }

    #[tokio::test]
    async fn committed_sse_drop_after_last_handoff_frame_is_completed() {
        assert_eq!(
            observed_terminal_after_drop(2).await,
            V3CommittedSseTerminal::Completed
        );
    }
}

pub enum V3ClientBody {
    Json(Value),
    Bytes(Vec<u8>),
    /// Runtime-projected client stream. The server owns the HTTP/SSE frame
    /// and heartbeat boundary; typed stream errors remain on the Error chain
    /// until the front transport projects the post-commit failure.
    Sse(V3ClientSseStream),
    /// Runtime-sealed client stream. Provider/Broker errors have already been
    /// resolved before this public boundary; only validated bytes may escape.
    CommittedSse(V3CommittedClientSseStream),
}

impl fmt::Debug for V3ClientBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(value) => formatter.debug_tuple("Json").field(value).finish(),
            Self::Bytes(bytes) => formatter
                .debug_struct("Bytes")
                .field("byte_len", &bytes.len())
                .finish(),
            Self::Sse(_) => formatter.write_str("Sse(<runtime-client-stream>)"),
            Self::CommittedSse(_) => formatter.write_str("CommittedSse(<front-event-stream>)"),
        }
    }
}

#[derive(Debug)]
pub struct V3Resp15ClientPayload {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: V3ClientBody,
}

pub fn build_v3_req_04_standardized_responses_from_v3_server_03(
    raw: V3Server03HttpRequestRaw,
) -> Result<V3Req04StandardizedResponses, String> {
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&raw.body) {
        return Err(format!(
            "RouteCodex side-channel field {key} cannot enter request payload"
        ));
    }
    let mut body = raw.body;
    match body.get("previous_response_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                return Err("previous_response_id must be null or a non-empty string".to_string());
            }
            Some(value.to_string())
        }
        Some(_) => {
            return Err("previous_response_id must be null or a non-empty string".to_string())
        }
    };
    // 与 chat direct / relay req_inbound 一致：历史轮图片占位符做语义等价归一化
    // （只清理历史轮图片引用，不影响当前轮输入；禁止在不可变区做任何修补）。
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut body);
    Ok(V3Req04StandardizedResponses {
        server_id: raw.server_id,
        port: raw.port,
        pipeline_id: raw.pipeline_id,
        failure_session_scope: raw.failure_session_scope,
        request_id: raw.request_id,
        execution_id: raw.execution_id,
        endpoint: raw.path,
        method: raw.method,
        request_purpose: raw.request_purpose,
        body,
        tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext::disabled(),
    })
}

pub fn build_v3_chat_req_04_standardized_from_v3_server_03(
    raw: V3Server03HttpRequestRaw,
) -> Result<V3Req04StandardizedChat, String> {
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&raw.body) {
        return Err(format!(
            "RouteCodex side-channel field {key} cannot enter request payload"
        ));
    }
    let mut body = raw.body;
    if body.get("messages").and_then(Value::as_array).is_none() {
        return Err("Chat request payload must contain a messages array".to_string());
    }
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut body);
    Ok(V3Req04StandardizedChat {
        server_id: raw.server_id,
        port: raw.port,
        pipeline_id: raw.pipeline_id,
        failure_session_scope: raw.failure_session_scope,
        request_id: raw.request_id,
        execution_id: raw.execution_id,
        endpoint: raw.path,
        method: raw.method,
        request_purpose: raw.request_purpose,
        body,
        tool_thinking_turn_context: crate::hub_v1::V3ToolThinkingTurnContext::disabled(),
    })
}

pub fn build_v3_router_request_facts_from_v3_req_04_chat(
    standardized: &V3Req04StandardizedChat,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    build_v3_router_request_facts_for_entry_with_control(
        &standardized.body,
        "openai_chat",
        configured_v3_longcontext_threshold_tokens(manifest, &standardized.server_id),
        false,
        standardized.request_purpose.is_compaction()
            || is_v3_compaction_endpoint(&standardized.endpoint),
        Some(manifest),
    )
}

pub fn build_v3_router_request_facts_from_v3_req_04(
    standardized: &V3Req04StandardizedResponses,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let entry_protocol = if standardized.endpoint.starts_with("/v1/messages") {
        "anthropic"
    } else {
        "responses"
    };
    let mut facts = build_v3_router_request_facts_for_entry_with_control(
        &standardized.body,
        entry_protocol,
        configured_v3_longcontext_threshold_tokens(manifest, &standardized.server_id),
        false,
        standardized.request_purpose.is_compaction()
            || is_v3_compaction_endpoint(&standardized.endpoint),
        Some(manifest),
    );
    if standardized.request_purpose.is_compaction()
        || is_v3_compaction_endpoint(&standardized.endpoint)
    {
        facts.client_model = None;
    }
    facts
}

pub fn build_v3_router_request_facts_for_entry(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    // 与真实路由一致：路由判定必须基于历史轮图片已归一化的 payload
    // （禁止 diagnostics dry-run / tests 与 cleaned 标准化路径发散）。
    let mut normalized = body.clone();
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut normalized);
    build_v3_router_request_facts_for_entry_with_control(
        &normalized,
        entry_protocol,
        longcontext_threshold_tokens,
        false,
        false,
        None,
    )
}

pub(crate) fn build_v3_router_request_facts_for_entry_and_endpoint(
    body: &Value,
    entry_protocol: &str,
    endpoint: &str,
    longcontext_threshold_tokens: Option<u64>,
    manifest: Option<&routecodex_v3_config::V3Config05ManifestPublished>,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let mut normalized = body.clone();
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut normalized);
    let mut facts = build_v3_router_request_facts_for_entry_with_control(
        &normalized,
        entry_protocol,
        longcontext_threshold_tokens,
        false,
        is_v3_compaction_endpoint(endpoint),
        manifest,
    );
    if is_v3_compaction_endpoint(endpoint) {
        facts.client_model = None;
    }
    facts
}

/// relay 目标解析（provider_failure_runtime_policy）使用的 facts 构建：
/// 携带 manifest，使 Mode B（web_search_execution_mode=metadata_center_local_search）
/// 的 web_search 声明贡献路由能力。真实故障 20260808：无 manifest 的
/// `build_v3_router_request_facts_for_entry` 使 Mode B 判定失效 → web_search
/// pool 不命中 → 落 default。
pub(crate) fn build_v3_router_request_facts_for_entry_with_manifest(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let mut normalized = body.clone();
    crate::hub_v1::normalize_v3_history_image_placeholders(&mut normalized);
    build_v3_router_request_facts_for_entry_with_control(
        &normalized,
        entry_protocol,
        longcontext_threshold_tokens,
        false,
        false,
        Some(manifest),
    )
}

fn build_v3_router_request_facts_for_entry_with_control(
    body: &Value,
    entry_protocol: &str,
    longcontext_threshold_tokens: Option<u64>,
    stopless_followup: bool,
    is_compaction: bool,
    manifest: Option<&routecodex_v3_config::V3Config05ManifestPublished>,
) -> routecodex_v3_virtual_router::V3RouterRequestFacts {
    let mut capabilities = BTreeSet::from(["text".to_string()]);
    let input_tokens = estimate_v3_routing_input_tokens(body);
    let active_turn = build_v3_current_turn_route_facts_from_value(body);
    let has_image_attachment = active_turn.has_current_turn_image;
    let declares_web_search_tool = request_declares_v3_web_search_tool(body, manifest);
    let route_facts = V3CurrentTurnRouteFacts {
        reached_long_context: longcontext_threshold_tokens
            .is_some_and(|threshold| input_tokens >= threshold),
        is_compaction: is_compaction || active_turn.is_compaction,
        has_image_attachment,
        latest_message_from_user: active_turn.latest_message_from_user,
        stopless_followup,
        has_current_turn_tool_output: active_turn.has_current_turn_tool_output,
        has_current_turn_tool_execution_error: active_turn.has_current_turn_tool_execution_error,
        has_current_turn_web_search: active_turn.has_current_turn_web_search,
        last_assistant_tool_category: active_turn
            .last_assistant_tool
            .as_ref()
            .map(|tool| tool.category.clone()),
        has_background_keyword: false,
        current_user_text: active_turn.current_user_text.clone(),
    };
    let route_classification = classify_route(&route_facts);
    for capability in &route_classification.required_capabilities {
        capabilities.insert(capability.clone());
    }
    if has_image_attachment {
        capabilities.insert("multimodal".to_string());
        capabilities.insert("vision".to_string());
    }
    if active_turn.has_current_turn_tool_output {
        capabilities.insert("tool_outputs".to_string());
    }
    if request_declares_v3_client_tool_surface(body) {
        capabilities.insert("tools".to_string());
    }
    if declares_web_search_tool {
        capabilities.insert("web_search".to_string());
    }
    routecodex_v3_virtual_router::V3RouterRequestFacts {
        entry_protocol: entry_protocol.to_string(),
        client_model: body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        capabilities,
        input_tokens,
        route_classification,
    }
}

fn is_v3_compaction_endpoint(endpoint: &str) -> bool {
    endpoint
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.eq_ignore_ascii_case("compact"))
}

fn request_declares_v3_client_tool_surface(body: &Value) -> bool {
    body.get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| tools.iter().any(is_v3_client_tool_declaration))
        || body
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("additional_tools")
                        && item
                            .get("tools")
                            .and_then(Value::as_array)
                            .is_some_and(|tools| tools.iter().any(is_v3_client_tool_declaration))
                })
            })
}

/// 客户端显式声明 websearch 工具：typed 当前轮路由事实，驱动 VR 命中候选 Mode B pool。
///
/// 两种形状按不同契约判定：
/// - function/custom 名为 websearch/web_search/web-search：无条件贡献 web_search
///   能力（fixlist item 1 验收：请求 model 非 Mode B（forwarder）但声明 websearch
///   工具时，VR 必须因 web_search 意图路由到 Mode B pool，再由候选 mode 在投影
///   层 fail-fast——Mode B 判定按 selected 候选 model 而非请求 model）。
/// - 标准 `{"type":"web_search"}` / `{"type":"web_search_preview"}` /
///   `{"type":"web_search_20250305","name":"web_search"}`：仅当请求 model 配置
///   Mode B 时贡献（v2-parity：非 Mode B 模型的原生 hosted 搜索由 provider 直接
///   处理，声明不改变路由）。
fn request_declares_v3_web_search_tool(
    body: &Value,
    manifest: Option<&routecodex_v3_config::V3Config05ManifestPublished>,
) -> bool {
    let declares = |tools: &Value, predicate: fn(&Value) -> bool| {
        tools
            .as_array()
            .is_some_and(|tools| tools.iter().any(predicate))
    };
    let declares_anywhere = |predicate: fn(&Value) -> bool| {
        body.get("tools")
            .is_some_and(|tools| declares(tools, predicate))
            || body
                .get("input")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("type").and_then(Value::as_str) == Some("additional_tools")
                            && item
                                .get("tools")
                                .is_some_and(|tools| declares(tools, predicate))
                    })
                })
    };
    // function/custom 命名 websearch 工具：无条件贡献（fixlist item 1）。
    if declares_anywhere(is_v3_web_search_function_tool_declaration) {
        return true;
    }
    // 标准形状：请求 model 必须配置 Mode B 才贡献（v2-parity）。
    let Some(manifest) = manifest else {
        return false;
    };
    let Some(model) = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let mode =
        crate::hub_v1::web_search_hop::resolve_web_search_mode_and_backend(manifest, model).0;
    mode.is_metadata_center_local_search()
        && declares_anywhere(is_v3_web_search_standard_declaration)
}

fn is_v3_web_search_function_tool_declaration(tool: &Value) -> bool {
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(kind.as_str(), "function" | "custom" | "") {
        return false;
    }
    let name = tool
        .pointer("/function/name")
        .or_else(|| tool.get("name"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(name.as_str(), "websearch" | "web_search" | "web-search")
}

fn is_v3_web_search_standard_declaration(tool: &Value) -> bool {
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        kind.as_str(),
        "web_search" | "web_search_preview" | "web_search_20250305"
    )
}

fn is_v3_client_tool_declaration(tool: &Value) -> bool {
    let kind = tool
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(kind.as_str(), "web_search" | "web_search_preview") {
        return false;
    }
    let name = tool
        .pointer("/function/name")
        .or_else(|| tool.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    !name.is_empty() && matches!(kind.as_str(), "function" | "custom" | "")
}

pub fn configured_v3_longcontext_threshold_tokens(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    server_id: &str,
) -> Option<u64> {
    manifest
        .servers
        .get(server_id)
        .and_then(|server| manifest.route_groups.get(&server.routing_group))
        .and_then(|group| group.pools.get("longcontext"))
        .and_then(|pool| pool.match_rule.as_ref())
        .and_then(|match_rule| match_rule.min_input_tokens)
}

fn estimate_v3_routing_input_tokens(body: &Value) -> u64 {
    crate::token_estimation::estimate_v3_request_tokens(body)
}

pub(crate) fn detect_v3_media_kind(
    values: &serde_json::Map<String, Value>,
) -> Option<&'static str> {
    let type_value = values
        .get("type")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if type_value.contains("video") {
        return Some("video");
    }
    if type_value.contains("image") {
        return Some("image");
    }
    if values.contains_key("video_url") {
        return Some("video");
    }
    if values.contains_key("image_url") {
        return Some("image");
    }
    let data = values
        .get("data")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if data.starts_with("data:video/") {
        return Some("video");
    }
    if data.starts_with("data:image/") {
        return Some("image");
    }
    None
}

pub fn build_v3_responses_direct_11_policy_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    standardized: &V3Req04StandardizedResponses,
) -> V3ResponsesDirect11Policy {
    V3ResponsesDirect11Policy {
        target: selected,
        request_id: standardized.request_id.clone(),
        request_body: standardized.body.clone(),
    }
}

pub fn build_v3_execution_11_protocol_decision_from_v3_target_10(
    selected: routecodex_v3_target::V3Target10ConcreteProviderSelected,
    entry_protocol: &str,
    allowed_modes: &[String],
) -> Result<V3Execution11ProtocolDecision, V3Error01SourceRaised> {
    let entry_protocol = entry_protocol_wire_protocol(entry_protocol)?;
    let selected_provider_protocol = crate::hub_v1::provider_wire_protocol_for_provider_type(
        &selected.candidate.provider_id,
        &selected.candidate.provider_type,
    )
    .map_err(|error| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "provider_protocol_unresolved",
            error,
        )
    })?;
    let direct_allowed = allowed_modes
        .iter()
        .any(|mode| mode.trim().eq_ignore_ascii_case("direct"));
    let relay_allowed = allowed_modes
        .iter()
        .any(|mode| mode.trim().eq_ignore_ascii_case("relay"));
    let responses_process_requires_relay = selected_provider_protocol
        == crate::hub_v1::V3HubProviderWireProtocol::Responses
        && selected
            .candidate
            .responses_process
            .as_deref()
            .map(|process| process.trim().eq_ignore_ascii_case("chat"))
            .unwrap_or(false);
    let mode = if responses_process_requires_relay {
        if !relay_allowed {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Execution11ProtocolDecision",
                "responses_process_chat_relay_not_allowed",
                "responses provider process=chat requires relay mode but relay is not allowed",
            ));
        }
        V3Execution11ProtocolDecisionMode::HubRelay
    } else if entry_protocol == selected_provider_protocol {
        if direct_allowed {
            V3Execution11ProtocolDecisionMode::SameProtocolDirect
        } else if relay_allowed {
            V3Execution11ProtocolDecisionMode::HubRelay
        } else {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3Execution11ProtocolDecision",
                "protocol_same_execution_mode_not_allowed",
                "same protocol selected target requires direct or relay mode but neither is allowed",
            ));
        }
    } else if relay_allowed {
        V3Execution11ProtocolDecisionMode::HubRelay
    } else {
        return Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "protocol_mismatch_relay_not_allowed",
            format!(
                "entry protocol {:?} selected provider protocol {:?} requires relay but relay is not allowed",
                entry_protocol, selected_provider_protocol
            ),
        ));
    };
    Ok(V3Execution11ProtocolDecision {
        mode,
        entry_protocol,
        selected_provider_protocol,
        target: selected,
    })
}

fn entry_protocol_wire_protocol(
    entry_protocol: &str,
) -> Result<crate::hub_v1::V3HubProviderWireProtocol, V3Error01SourceRaised> {
    match entry_protocol.trim() {
        "responses" | "openai_responses" | "openai-responses" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Responses)
        }
        "anthropic" | "anthropic_messages" | "anthropic-messages" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Anthropic)
        }
        "openai_chat" | "openai-chat" | "chat_completions" | "chat-completions" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::OpenAiChat)
        }
        "gemini" | "gemini_chat" | "gemini-chat" => {
            Ok(crate::hub_v1::V3HubProviderWireProtocol::Gemini)
        }
        other => Err(build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3Execution11ProtocolDecision",
            "entry_protocol_unresolved",
            format!("unsupported entry protocol for protocol decision: {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_v3_chat_req_04_standardized_from_v3_server_03,
        build_v3_req_04_standardized_responses_from_v3_server_03,
        build_v3_router_request_facts_for_entry,
        build_v3_router_request_facts_for_entry_with_control,
        build_v3_router_request_facts_from_v3_req_04_chat, build_v3_server_03_http_request_raw,
        build_v3_server_03_http_request_raw_with_purpose,
        build_v3_server_03_http_request_raw_with_purpose_and_scope, V3RequestPurpose,
    };
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_error::V3ProviderFailureSessionScope;
    use serde_json::json;

    const TEST_LONGCONTEXT_THRESHOLD_TOKENS: Option<u64> = Some(180_000);

    #[test]
    fn req04_carries_listener_port_as_typed_scope_only() {
        let raw = build_v3_server_03_http_request_raw_with_purpose_and_scope(
            "server".to_string(),
            V3ProviderFailureSessionScope::new("server", "default", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/responses".to_string(),
            V3RequestPurpose::Conversation,
            Some(7777),
            Some("responses-pipeline-1".to_string()),
            json!({"model":"gpt-5.5","input":[]}),
        );
        let normalized = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
            .expect("Responses inbound must preserve typed scope");
        assert_eq!(normalized.port, Some(7777));
        assert_eq!(
            normalized.pipeline_id.as_deref(),
            Some("responses-pipeline-1")
        );
        assert!(normalized.body.get("port").is_none());
    }

    #[test]
    fn req04_preserves_responses_data_and_extracts_typed_continuation_locator() {
        let raw = build_v3_server_03_http_request_raw(
            "server".to_string(),
            V3ProviderFailureSessionScope::new("server", "default", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/responses".to_string(),
            json!({
                "model":"gpt-5.5",
                "previous_response_id":"resp_typed_1",
                "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
                "include":["reasoning.encrypted_content"]
            }),
        );

        let normalized = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
            .expect("Responses inbound must preserve same-protocol data");

        assert!(normalized.body.get("messages").is_none());
        assert!(normalized.body.get("input").is_some());
        assert_eq!(normalized.body["include"][0], "reasoning.encrypted_content");
        assert_eq!(normalized.body["previous_response_id"], "resp_typed_1");
    }

    #[test]
    fn req04_treats_null_previous_response_id_as_fresh_request() {
        let raw = build_v3_server_03_http_request_raw(
            "server".to_string(),
            V3ProviderFailureSessionScope::new("server", "default", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/responses".to_string(),
            json!({
                "model":"gpt-5.5",
                "previous_response_id": null,
                "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]
            }),
        );

        let normalized = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
            .expect("null previous_response_id is semantically absent");

        assert!(normalized.body["previous_response_id"].is_null());
        assert_eq!(normalized.body["model"], "gpt-5.5");
    }

    #[test]
    fn anthropic_messages_req04_preserves_entry_protocol_for_route_facts() {
        let raw = build_v3_server_03_http_request_raw(
            "server".to_string(),
            V3ProviderFailureSessionScope::new("server", "default", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/messages".to_string(),
            json!({
                "model": "claude-client-alias",
                "messages": [{"role": "user", "content": "call pwd"}],
                "tools": [{"name": "pwd", "description": "cwd", "input_schema": {"type": "object"}}]
            }),
        );
        let normalized = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
            .expect("Anthropic messages request must normalize");
        let facts = super::build_v3_router_request_facts_from_v3_req_04(
            &normalized,
            &manifest_mode_b_websearch_for_routing_facts(),
        );

        assert_eq!(facts.entry_protocol, "anthropic");
    }

    #[test]
    fn auxiliary_compaction_purpose_reaches_responses_route_facts() {
        let raw = build_v3_server_03_http_request_raw_with_purpose(
            "controlled".to_string(),
            V3ProviderFailureSessionScope::new("controlled", "controlled", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/responses".to_string(),
            V3RequestPurpose::AuxiliaryCompaction,
            json!({
                "model": "gpt-5.5",
                "input": "compact this conversation"
            }),
        );
        let normalized = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
            .expect("auxiliary compaction must normalize as Responses");
        let facts = super::build_v3_router_request_facts_from_v3_req_04(
            &normalized,
            &manifest_mode_b_websearch_for_routing_facts(),
        );

        assert_eq!(facts.route_classification.route_name, "compact");
        assert!(facts
            .route_classification
            .reasoning
            .contains("compact:registered-ingress"));
    }

    #[test]
    fn declared_web_search_tool_does_not_activate_web_search_route() {
        let request = serde_json::json!({
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "fix the routing bug"}],
            "tools": [{"type": "function", "function": {
                "name": "web_search",
                "description": "search the web",
                "parameters": {"type": "object"}
            }}]
        });

        let facts = build_v3_router_request_facts_for_entry(&request, "chat", None);
        assert_ne!(
            facts.route_classification.route_name, "web_search",
            "declared tools are not current-turn web-search evidence"
        );
        assert!(!facts
            .route_classification
            .required_capabilities
            .iter()
            .any(|capability| capability == "web_search"));
    }

    #[test]
    fn req04_rejects_malformed_previous_response_id_instead_of_starting_fresh() {
        for previous_response_id in [json!(""), json!(42), json!({"id":"resp_1"}), json!([])] {
            let raw = build_v3_server_03_http_request_raw(
                "server".to_string(),
                V3ProviderFailureSessionScope::new("server", "default", "request")
                    .expect("failure scope"),
                "request".to_string(),
                "execution".to_string(),
                "POST".to_string(),
                "/v1/responses".to_string(),
                json!({
                    "model":"gpt-5.5",
                    "previous_response_id": previous_response_id,
                    "input":"hello"
                }),
            );

            let error = build_v3_req_04_standardized_responses_from_v3_server_03(raw)
                .expect_err("malformed continuation locator must fail before routing");
            assert_eq!(
                error,
                "previous_response_id must be null or a non-empty string"
            );
        }
    }

    #[test]
    fn v3_routing_token_estimate_omits_image_payload_bytes() {
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." }
                    ]
                }
            ],
            "tools": []
        });
        let with_image = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "Describe this image." },
                        {
                            "type": "input_image",
                            "image_url": {
                                "url": format!("data:image/png;base64,{}", "A".repeat(1_200_000))
                            }
                        }
                    ]
                }
            ],
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(
            &base,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;
        let image_tokens = build_v3_router_request_facts_for_entry(
            &with_image,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;

        assert!(
            image_tokens <= base_tokens + 8,
            "V3 routing token estimate must omit image/base64 bytes like the V2 Rust estimator; base={base_tokens}, image={image_tokens}"
        );
    }

    #[test]
    fn v3_routing_facts_use_protocol_image_as_multimodal_signal() {
        let request = json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Describe this image."},
                        {"type": "input_image", "image_url": {"url": "data:image/png;base64,AAAA"}}
                    ]
                }
            ],
            "tools": []
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(facts.capabilities.contains("multimodal"));
        assert!(facts.capabilities.contains("vision"));
    }

    #[test]
    fn v3_chat_direct_facts_current_turn_image_with_tool_history_routes_multimodal() {
        // 用户 TUI（pocketcode）真实特征：多轮工具历史 + reasoning_content + 当前轮图。
        // direct chat 路径 facts 必须仍识别当前轮图为 multimodal（曾落 default 打到
        // opencode-go 上游 → 400 unknown variant image_url）。
        let raw = build_v3_server_03_http_request_raw(
            "server".to_string(),
            V3ProviderFailureSessionScope::new("server", "default", "request")
                .expect("failure scope"),
            "request".to_string(),
            "execution".to_string(),
            "POST".to_string(),
            "/v1/chat/completions".to_string(),
            json!({
                "model": "deepseek-v4-flash",
                "messages": [
                    {"role": "user", "content": "帮我看看当前仓库的改动"},
                    {"role": "assistant", "content": null, "reasoning_content": "思考",
                     "tool_calls": [{"id": "call_1", "type": "function",
                                     "function": {"name": "bash", "arguments": "{}"}}]},
                    {"role": "tool", "tool_call_id": "call_1", "content": " M package.json"},
                    {"role": "user", "content": "好的，继续"},
                    {"role": "assistant", "content": "已看到", "reasoning_content": "确认"},
                    {"role": "user", "content": [
                        {"type": "text", "text": "这张截图里有什么？"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                    ]}
                ]
            }),
        );
        let normalized =
            build_v3_chat_req_04_standardized_from_v3_server_03(raw).expect("chat req04 normalize");
        let facts = build_v3_router_request_facts_from_v3_req_04_chat(
            &normalized,
            &manifest_mode_b_websearch_for_routing_facts(),
        );
        assert!(
            facts.capabilities.contains("multimodal"),
            "current-turn image with tool history must route multimodal; caps={:?}",
            facts.capabilities
        );
    }

    #[test]
    fn v3_routing_facts_ignore_client_metadata_image_claim_without_protocol_image() {
        let request = json!({
            "model": "gpt-5.6-sol",
            "metadata": {"hasImageAttachment": true},
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Describe this image [Image #1]."}
                ]
            }]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(!facts.capabilities.contains("multimodal"));
        assert!(!facts.capabilities.contains("vision"));
    }

    #[test]
    fn v3_routing_facts_ignore_client_runtime_control_metadata() {
        let request = json!({
            "model": "gpt-5.5",
            "metadata": {"runtime_control": {"serverToolFollowup": true}},
            "input": [{"role":"user","content":"continue"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert_eq!(
            facts.route_classification.candidates,
            ["thinking", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_do_not_model_stream_as_capability() {
        let request = json!({
            "model": "gpt-5.5",
            "stream": true,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "ping"}
                    ]
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(facts.capabilities.contains("text"));
        assert!(
            !facts.capabilities.contains("streaming"),
            "stream is a transport intent, not a routing/model capability"
        );
    }

    #[test]
    fn v3_routing_facts_do_not_use_reasoning_as_route_signal() {
        let request = json!({
            "model": "gpt-5.5",
            "reasoning": {"effort": "medium"},
            "input": [
                {"role":"user","content":"apply the patch"},
                {
                    "type":"custom_tool_call",
                    "name":"apply_patch",
                    "call_id":"call_patch",
                    "input":"*** Begin Patch\n*** Update File: a\n*** End Patch"
                },
                {
                    "type":"custom_tool_call_output",
                    "call_id":"call_patch",
                    "output":"Done!"
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "coding");
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("reasoning"));
    }

    #[test]
    fn v3_routing_facts_mark_current_user_input_as_thinking() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [{"role":"user","content":"继续按照合同进行修复"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(
            !facts.capabilities.contains("thinking"),
            "thinking is a route classification, not a target capability: {:?}",
            facts.capabilities
        );
        assert_eq!(facts.route_classification.route_name, "thinking");
        assert_eq!(
            facts.route_classification.candidates,
            ["thinking", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_use_configured_longcontext_threshold() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [{"role":"user","content":"short request"}]
        });

        let below_configured_threshold =
            build_v3_router_request_facts_for_entry(&request, "responses", Some(10_000));
        assert_eq!(
            below_configured_threshold.route_classification.route_name,
            "thinking"
        );

        let at_configured_threshold =
            build_v3_router_request_facts_for_entry(&request, "responses", Some(1));
        assert_eq!(
            at_configured_threshold.route_classification.route_name,
            "longcontext"
        );
        assert_eq!(
            at_configured_threshold.route_classification.candidates,
            ["longcontext", "default"]
        );
    }

    #[test]
    fn v3_routing_facts_mark_declared_codex_tool_surface_for_tools_pool() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [
                {
                    "role": "developer",
                    "tools": [
                        {"type":"function","name":"exec_command"},
                        {"type":"function","name":"apply_patch"},
                        {"type":"function","name":"tool_search"}
                    ],
                    "type": "additional_tools"
                },
                {"role":"user","content":"继续实现并验证"}
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(facts.capabilities.contains("tools"));
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("search"));
    }

    #[test]
    fn v3_routing_facts_ignore_stringified_tool_surface_text() {
        let request = json!({
            "model": "gpt-5.5",
            "input": "[{\"role\":\"developer\",\"type\":\"additional_tools\",\"tools\":[{\"type\":\"function\",\"name\":\"exec_command\"}]}]",
            "messages": [{"role":"user","content":"继续实现并验证"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert!(!facts.capabilities.contains("tools"));
    }

    #[test]
    fn v3_routing_facts_ignore_declared_web_search_builtin_surface() {
        let request = json!({
            "model": "gpt-5.5",
            "tools": [
                {"type":"web_search"},
                {"type":"web_search_preview"}
            ],
            "input": [{"role":"user","content":"continue the implementation"}]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("tools"));
        assert!(!facts.capabilities.contains("web_search"));
        assert!(!facts.capabilities.contains("coding"));
    }

    #[test]
    fn v3_routing_facts_canonical_web_search_tool_declaration_contributes_capability() {
        // canonical（responses → chat）的 tools 数组含标准 `{"type":"web_search"}`
        // 声明（responses web_search item 转换形状）+ Mode B 请求 model 时
        // 必须产生 web_search 能力——真实路由的 facts 在 canonical 上构建
        // （kernel/foundation 传 req04 的 canonical payload），仅检测原始 input
        // part 或 function/custom websearch 名都会漏检 → web_search pool 不命中、
        // 落 default（真实故障 20260808）。
        let manifest = manifest_mode_b_websearch_for_routing_facts();
        let request = json!({
            "model": "MiniMax-M3",
            "messages": [{"role": "user", "content": "search routecodex"}],
            "tools": [{"type": "web_search"}]
        });
        let facts = build_v3_router_request_facts_for_entry_with_control(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            false,
            false,
            Some(&manifest),
        );
        assert!(
            facts.capabilities.contains("web_search"),
            "canonical web_search tool declaration must contribute web_search capability: {:?}",
            facts.capabilities
        );
    }

    #[test]
    fn v3_routing_facts_anthropic_hosted_web_search_20250305_declaration_contributes_capability() {
        // anthropic hosted server tool 风格声明（`{"type":"web_search_20250305",
        // "name":"web_search"}`，MiniMax/Anthropic hosted web_search）与 responses
        // 标准 `{"type":"web_search"}` 是两种 web search capability 形状，都必须
        // 贡献 web_search 路由能力（声明决定路由）——否则 anthropic 入口的 hosted
        // web_search 声明不命中 web_search 池、落 default（真实故障风险）。
        let manifest = manifest_mode_b_websearch_for_routing_facts();
        let request = json!({
            "model": "MiniMax-M3",
            "messages": [{"role": "user", "content": "search routecodex"}],
            "tools": [{"type": "web_search_20250305", "name": "web_search"}]
        });
        let facts = build_v3_router_request_facts_for_entry_with_control(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            false,
            false,
            Some(&manifest),
        );
        assert!(
            facts.capabilities.contains("web_search"),
            "anthropic hosted web_search_20250305 declaration must contribute web_search capability: {:?}",
            facts.capabilities
        );
    }

    #[test]
    fn v3_routing_facts_canonical_web_search_declaration_without_mode_b_model_stays_idle() {
        // v2-parity：非 Mode B 模型（gpt-5.5 原生 hosted）的 web_search 声明
        // 不贡献 web_search 路由能力（provider 原生处理搜索，无需本地 hop 路由）。
        let manifest = manifest_mode_b_websearch_for_routing_facts();
        let request = json!({
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "continue"}],
            "tools": [{"type": "web_search"}]
        });
        let facts = build_v3_router_request_facts_for_entry_with_control(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            false,
            false,
            Some(&manifest),
        );
        assert!(
            !facts.capabilities.contains("web_search"),
            "non-Mode-B model web_search declaration must not contribute: {:?}",
            facts.capabilities
        );
    }

    fn manifest_mode_b_websearch_for_routing_facts(
    ) -> routecodex_v3_config::V3Config05ManifestPublished {
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(
                r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.controlled.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn v3_routing_facts_current_turn_web_search_input_part_contributes_capability() {
        // 当前轮显式 web_search part（Responses input 数组）必须产生 web_search
        // 能力（否则 web_search pool 不命中、落 default——真实故障 20260808）。
        let request = json!({
            "model": "MiniMax-M3",
            "input": [
                {"type": "web_search", "query": "routecodex"},
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "search routecodex"}]
                }
            ]
        });
        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );
        assert!(
            facts.capabilities.contains("web_search"),
            "responses input web_search part must contribute web_search capability: {:?}",
            facts.capabilities
        );
    }

    #[test]
    fn v3_routing_facts_classify_actual_current_turn_tools() {
        let classify = |name: &str, arguments: serde_json::Value| {
            let request = json!({
                "model": "gpt-5.5",
                "tools": [{"type":"web_search"}],
                "input": [
                    {"role":"user","content":"continue"},
                    {
                        "type":"function_call",
                        "name":name,
                        "call_id":"call_tool",
                        "arguments":arguments
                    },
                    {
                        "type":"function_call_output",
                        "call_id":"call_tool",
                        "output":"ok"
                    }
                ]
            });
            build_v3_router_request_facts_for_entry(
                &request,
                "responses",
                TEST_LONGCONTEXT_THRESHOLD_TOKENS,
            )
        };

        let thinking = classify("exec_command", json!({"cmd":"cat src/lib.rs"}));
        assert_eq!(thinking.route_classification.route_name, "thinking");
        assert!(!thinking.capabilities.contains("thinking"));
        assert!(!thinking.capabilities.contains("web_search"));

        let search = classify("exec_command", json!({"cmd":"rg -n route src"}));
        assert_eq!(search.route_classification.route_name, "search");
        assert!(!search.capabilities.contains("search"));

        let tools = classify("exec_command", json!({"cmd":"cargo test"}));
        assert_eq!(tools.route_classification.route_name, "tools");
        assert!(!tools.capabilities.contains("tools"));

        let web = classify("web_search", json!({"query":"latest release"}));
        assert_eq!(web.route_classification.route_name, "web_search");
        assert_eq!(
            web.route_classification.candidates,
            ["web_search", "default"]
        );
        assert!(web.capabilities.contains("web_search"));
    }

    #[test]
    fn v3_routing_facts_ignore_historical_tools_after_new_user_turn() {
        let request = json!({
            "model": "gpt-5.5",
            "input": [
                {"role":"user","content":"search the repo"},
                {
                    "type":"function_call",
                    "name":"exec_command",
                    "call_id":"call_old",
                    "arguments":{"cmd":"rg -n route src"}
                },
                {"type":"function_call_output","call_id":"call_old","output":"old"},
                {"role":"user","content":"now explain the result"}
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "thinking");
        assert!(!facts.capabilities.contains("thinking"));
        assert!(!facts.capabilities.contains("search"));
        assert!(!facts.capabilities.contains("tools"));
    }

    #[test]
    fn v3_routing_facts_classify_old_failure_sample_as_coding_not_web_search() {
        let request = json!({
            "model": "gpt-5.5",
            "metadata": null,
            "reasoning": {"effort":"medium","summary":"detailed"},
            "tools": [
                {"type":"web_search"},
                {"type":"custom","name":"apply_patch"}
            ],
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]},
                {
                    "type":"custom_tool_call",
                    "name":"apply_patch",
                    "call_id":"call_019fa961f9cc765083b8b8d3",
                    "input":"*** Update File: v3/crates/routecodex-v3-server/src/lib.rs"
                },
                {
                    "type":"custom_tool_call_output",
                    "call_id":"call_019fa961f9cc765083b8b8d3",
                    "output":"apply_patch verification failed"
                }
            ]
        });

        let facts = build_v3_router_request_facts_for_entry(
            &request,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        );

        assert_eq!(facts.route_classification.route_name, "coding");
        assert!(!facts.capabilities.contains("coding"));
        assert!(!facts.capabilities.contains("web_search"));
        assert_eq!(facts.route_classification.candidates, ["coding", "default"]);
    }

    #[test]
    fn v3_routing_token_estimate_omits_stringified_media_payloads() {
        let base_input = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." }
        ]))
        .unwrap();
        let base = json!({
            "model": "gpt-5.6-sol",
            "input": base_input,
            "tools": []
        });
        let stringified = serde_json::to_string(&json!([
            { "type": "input_text", "text": "Summarize this clip." },
            {
                "type": "input_video",
                "video_url": format!("data:video/mp4;base64,{}", "B".repeat(1_200_000))
            }
        ]))
        .unwrap();
        let with_video = json!({
            "model": "gpt-5.6-sol",
            "input": stringified,
            "tools": []
        });

        let base_tokens = build_v3_router_request_facts_for_entry(
            &base,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;
        let video_tokens = build_v3_router_request_facts_for_entry(
            &with_video,
            "responses",
            TEST_LONGCONTEXT_THRESHOLD_TOKENS,
        )
        .input_tokens;

        assert!(
            video_tokens <= base_tokens + 12,
            "V3 routing token estimate must omit stringified media/base64 bytes like the V2 Rust estimator; base={base_tokens}, video={video_tokens}"
        );
    }
}
